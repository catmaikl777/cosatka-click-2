const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
// Database
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, 'data.db'));

const app = express();
const server = http.createServer(app);

// Получаем разрешенные домены из переменных окружения
const allowedOrigins = 'https://cosatka-click-2.vercel.app'

// Настройки CORS для Socket.IO
const io = socketIo(server, {
    cors: {
        origin: function (origin, callback) {
            // Разрешаем запросы без origin (например, из мобильных приложений или Postman)
            if (!origin) return callback(null, true);
            
            if (allowedOrigins.indexOf(origin) === -1) {
                const msg = `Домен ${origin} не разрешен политикой CORS.`;
                console.log(msg);
                return callback(new Error(msg), false);
            }
            return callback(null, true);
        },
        methods: ["GET", "POST"],
        credentials: true
    }
});

// Улучшенное middleware для обработки CORS
app.use((req, res, next) => {
    const origin = req.headers.origin;
    
    if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    // Обработка preflight запросов
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    
    next();
});

// Middleware для парсинга JSON
app.use(express.json());

// Статические файлы
app.use(express.static(path.join(__dirname, 'public')));

// If index.html is in the project root, serve it at '/'
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Данные игроков
let players = [];

// Данные активных баттлов
let battles = [];

// Конфигурация баттлов
const BATTLE_CONFIG = {
    MAX_HEALTH: 100,
    ATTACK_COST: 10,
    SPECIAL_ATTACK_COST: 25,
    BASE_ATTACK_DAMAGE: 10,
    SPECIAL_ATTACK_DAMAGE: 25,
    DEFENSE_BONUS: 5,
    TURN_TIME: 30000, // 30 секунд на ход
    MAX_TURNS: 20
};

// --- ИНИЦИАЛИЗАЦИЯ БАЗЫ ДАННЫХ ---
db.exec(`
CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    name TEXT,
    resources INTEGER DEFAULT 0,
    clickPower INTEGER DEFAULT 1,
    autoPower INTEGER DEFAULT 0,
    currentSkin TEXT DEFAULT 'default',
    joinedAt TEXT
);

CREATE TABLE IF NOT EXISTS clans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    ownerId TEXT,
    createdAt TEXT
);

CREATE TABLE IF NOT EXISTS clan_members (
    clanId INTEGER,
    playerId TEXT,
    role TEXT DEFAULT 'member',
    PRIMARY KEY (clanId, playerId)
);

CREATE TABLE IF NOT EXISTS daily_tasks (
    id INTEGER PRIMARY KEY,
    title TEXT,
    description TEXT,
    reward INTEGER,
    repeat_interval_days INTEGER DEFAULT 1,
    createdAt TEXT
);

CREATE TABLE IF NOT EXISTS player_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playerId TEXT,
    taskId INTEGER,
    status TEXT,
    lastCompletedAt TEXT
);
`);

// Seed simple daily tasks if table empty
const taskCount = db.prepare('SELECT COUNT(*) as c FROM daily_tasks').get().c;
if (taskCount === 0) {
    const insertTask = db.prepare('INSERT INTO daily_tasks (id, title, description, reward, repeat_interval_days, createdAt) VALUES (?, ?, ?, ?, ?, ?)');
    insertTask.run(1, 'Поймать 50 рыбок', 'Соберите 50 рыбок за день', 100, 1, new Date().toISOString());
    insertTask.run(2, 'Сделать 100 кликов', 'Совершите 100 кликов за день', 150, 1, new Date().toISOString());
    insertTask.run(3, 'Победить в 1 баттле', 'Выиграйте один баттл', 200, 1, new Date().toISOString());
}

// Helper statements
const upsertPlayerStmt = db.prepare(`INSERT INTO players(id, name, resources, clickPower, autoPower, currentSkin, joinedAt)
    VALUES (@id, @name, @resources, @clickPower, @autoPower, @currentSkin, @joinedAt)
    ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        resources=excluded.resources,
        clickPower=excluded.clickPower,
        autoPower=excluded.autoPower,
        currentSkin=excluded.currentSkin
`);

const getTopPlayersStmt = db.prepare('SELECT id, name, resources FROM players ORDER BY resources DESC LIMIT ?');
const getPlayerStmt = db.prepare('SELECT * FROM players WHERE id = ?');
const updatePlayerResourcesStmt = db.prepare('UPDATE players SET resources = ? WHERE id = ?');
const insertClanStmt = db.prepare('INSERT INTO clans (name, ownerId, createdAt) VALUES (?, ?, ?)');
const getClansStmt = db.prepare('SELECT * FROM clans');
const getClanMembersStmt = db.prepare('SELECT p.id, p.name, cm.role FROM clan_members cm JOIN players p ON cm.playerId = p.id WHERE cm.clanId = ?');
const addClanMemberStmt = db.prepare('INSERT OR REPLACE INTO clan_members (clanId, playerId, role) VALUES (?, ?, ?)');
const getDailyTasksStmt = db.prepare('SELECT * FROM daily_tasks');
const getPlayerTaskStmt = db.prepare('SELECT * FROM player_tasks WHERE playerId = ? AND taskId = ?');
const insertPlayerTaskStmt = db.prepare('INSERT INTO player_tasks (playerId, taskId, status, lastCompletedAt) VALUES (?, ?, ?, ?)');
const updatePlayerTaskStmt = db.prepare('UPDATE player_tasks SET status = ?, lastCompletedAt = ? WHERE playerId = ? AND taskId = ?');

// Класс баттла
class Battle {
    constructor(player1, player2) {
        this.id = this.generateBattleId();
        this.player1 = player1;
        this.player2 = player2;
        this.players = [player1, player2];
        this.turn = 0;
        this.currentPlayer = player1.id;
        this.health = {
            [player1.id]: BATTLE_CONFIG.MAX_HEALTH,
            [player2.id]: BATTLE_CONFIG.MAX_HEALTH
        };
        this.actions = [];
        this.status = 'active'; // active, finished, cancelled
        this.winner = null;
        this.startTime = new Date();
        this.lastActionTime = new Date();
        this.turnTimer = null;
    }

    generateBattleId() {
        return 'battle_' + Math.random().toString(36).substr(2, 9);
    }

    // Получить оппонента
    getOpponent(playerId) {
        return playerId === this.player1.id ? this.player2 : this.player1;
    }

    // Проверить, является ли игрок участником баттла
    isParticipant(playerId) {
        return this.player1.id === playerId || this.player2.id === playerId;
    }

    // Выполнить атаку
    performAttack(attackerId, isSpecial = false) {
        if (this.status !== 'active') return false;
        if (this.currentPlayer !== attackerId) return false;

        const attacker = attackerId === this.player1.id ? this.player1 : this.player2;
        const defender = this.getOpponent(attackerId);
        
        const cost = isSpecial ? BATTLE_CONFIG.SPECIAL_ATTACK_COST : BATTLE_CONFIG.ATTACK_COST;
        
        // Проверяем достаточно ли ресурсов
        if (attacker.resources < cost) return false;

        // Вычитаем стоимость атаки
        const attackerIndex = players.findIndex(p => p.id === attackerId);
        if (attackerIndex !== -1) {
            players[attackerIndex].resources -= cost;
            try {
                updatePlayerResourcesStmt.run(players[attackerIndex].resources, players[attackerIndex].id);
            } catch (err) {
                console.error('DB update after attack error', err);
            }
        }

        // Вычисляем урон
        let damage = isSpecial ? BATTLE_CONFIG.SPECIAL_ATTACK_DAMAGE : BATTLE_CONFIG.BASE_ATTACK_DAMAGE;
        
        // Добавляем бонус от силы клика (10% от clickPower)
        const clickBonus = Math.floor(attacker.clickPower * 0.1);
        damage += clickBonus;

        // Случайный разброс урона ±20%
        const variance = Math.floor(damage * 0.2);
        damage += Math.floor(Math.random() * (variance * 2 + 1)) - variance;

        // Применяем урон
        this.health[defender.id] = Math.max(0, this.health[defender.id] - damage);

        // Записываем действие
        const action = {
            type: isSpecial ? 'special' : 'attack',
            attacker: attacker.name,
            defender: defender.name,
            damage: damage,
            cost: cost,
            turn: this.turn,
            timestamp: new Date()
        };

        this.actions.push(action);
        this.lastActionTime = new Date();

        // Проверяем окончание баттла
        if (this.health[defender.id] <= 0) {
            this.finishBattle(attackerId);
            action.battleEnd = true;
            action.winner = attacker.name;
        } else {
            // Передаем ход следующему игроку
            this.currentPlayer = defender.id;
            this.turn++;
            
            // Проверяем максимальное количество ходов
            if (this.turn >= BATTLE_CONFIG.MAX_TURNS) {
                this.finishBattle(this.getWinnerByHealth());
            }
        }

        // Обновляем данные игроков
        io.emit('players-update', players);

        return action;
    }

    // Завершить баттл
    finishBattle(winnerId) {
        this.status = 'finished';
        this.winner = winnerId;
        
        // Награждаем победителя
        const reward = 50 + this.turn * 5; // Базовая награда + за каждый ход
        const winnerIndex = players.findIndex(p => p.id === winnerId);
        if (winnerIndex !== -1) {
            players[winnerIndex].resources += reward;
            try {
                updatePlayerResourcesStmt.run(players[winnerIndex].resources, players[winnerIndex].id);
            } catch (err) {
                console.error('DB update after reward error', err);
            }
        }

        // Останавливаем таймер
        if (this.turnTimer) {
            clearTimeout(this.turnTimer);
        }

        // Обновляем данные игроков
        io.emit('players-update', players);
    }

    // Определить победителя по здоровью
    getWinnerByHealth() {
        if (this.health[this.player1.id] > this.health[this.player2.id]) {
            return this.player1.id;
        } else if (this.health[this.player2.id] > this.health[this.player1.id]) {
            return this.player2.id;
        } else {
            // Ничья - случайный победитель
            return Math.random() > 0.5 ? this.player1.id : this.player2.id;
        }
    }

    // Получить данные баттла для клиента
    getBattleData() {
        return {
            id: this.id,
            player1: {
                id: this.player1.id,
                name: this.player1.name,
                health: this.health[this.player1.id],
                maxHealth: BATTLE_CONFIG.MAX_HEALTH
            },
            player2: {
                id: this.player2.id,
                name: this.player2.name,
                health: this.health[this.player2.id],
                maxHealth: BATTLE_CONFIG.MAX_HEALTH
            },
            currentPlayer: this.currentPlayer,
            turn: this.turn,
            status: this.status,
            winner: this.winner,
            actions: this.actions.slice(-10) // Последние 10 действий
        };
    }

    // Запустить таймер хода
    startTurnTimer() {
        if (this.turnTimer) {
            clearTimeout(this.turnTimer);
        }

        this.turnTimer = setTimeout(() => {
            if (this.status === 'active') {
                // Игрок пропустил ход - наносится небольшой урон
                const skippedPlayer = this.currentPlayer;
                const opponent = this.getOpponent(skippedPlayer);
                
                this.health[skippedPlayer] = Math.max(0, this.health[skippedPlayer] - 5);
                
                const action = {
                    type: 'timeout',
                    player: skippedPlayer,
                    damage: 5,
                    turn: this.turn,
                    timestamp: new Date()
                };

                this.actions.push(action);

                // Проверяем окончание баттла
                if (this.health[skippedPlayer] <= 0) {
                    this.finishBattle(opponent.id);
                    action.battleEnd = true;
                    action.winner = opponent.name;
                } else {
                    // Передаем ход
                    this.currentPlayer = opponent.id;
                    this.turn++;
                    this.startTurnTimer();
                }

                // Отправляем обновление
                this.broadcastBattleUpdate();
            }
        }, BATTLE_CONFIG.TURN_TIME);
    }

    // Отправить обновление баттла всем участникам
    broadcastBattleUpdate() {
        const battleData = this.getBattleData();
        this.players.forEach(player => {
            io.to(player.id).emit('battle-update', battleData);
        });
    }

    // Отменить баттл
    cancelBattle(reason = 'Баттл отменен') {
        this.status = 'cancelled';
        
        if (this.turnTimer) {
            clearTimeout(this.turnTimer);
        }

        const cancelAction = {
            type: 'cancel',
            reason: reason,
            timestamp: new Date()
        };

        this.actions.push(cancelAction);
        this.broadcastBattleUpdate();
    }
}

// Обработка подключений
io.on('connection', (socket) => {
    console.log('Новый игрок подключился:', socket.id);
    
    // Отправляем текущему игроку список всех игроков сразу после подключения
    socket.emit('players-update', players);
    
    // Обработчик присоединения игрока
    socket.on('player-join', (playerData) => {
        console.log('Игрок присоединяется:', playerData);
        
        // Проверяем и корректируем имя если нужно
        let playerName = (playerData && playerData.name) ? String(playerData.name).trim() : null;
        if (!playerName) {
            playerName = 'Кот_' + (100 + Math.floor(Math.random() * 900));
        }

        // If name already exists, append at most one short numeric suffix. If the supplied name already
        // contains a trailing _NNN-like suffix, strip it before comparing to avoid repeated growth.
        const stripSuffix = (n) => n.replace(/_[0-9]{2,4}$/, '');
        const baseName = stripSuffix(playerName);
        const existingPlayer = players.find(p => stripSuffix(p.name) === baseName);
        if (existingPlayer) {
            // Append a single short suffix
            const suffix = 100 + Math.floor(Math.random() * 900);
            playerName = baseName + '_' + suffix;
        }
        
        // If this socket is already known, update the existing player instead of adding a duplicate
        const existingIndex = players.findIndex(p => p.id === socket.id);
        let player;
        if (existingIndex !== -1) {
            player = players[existingIndex];
            const oldName = player.name;
            player.name = playerName;
            player.resources = playerData.resources != null ? playerData.resources : player.resources;
            player.clickPower = playerData.clickPower != null ? playerData.clickPower : player.clickPower;
            player.autoPower = playerData.autoPower != null ? playerData.autoPower : player.autoPower;
            player.currentSkin = playerData.currentSkin || player.currentSkin;
            // keep joinedAt
            console.log(`Игрок ${oldName} обновил профиль -> ${player.name}`);
        } else {
            // Создаем объект игрока
            player = {
                id: socket.id,
                name: playerName,
                resources: playerData.resources || 0,
                clickPower: playerData.clickPower || 1,
                autoPower: playerData.autoPower || 0,
                currentSkin: playerData.currentSkin || 'default',
                inBattle: false,
                battleId: null,
                joinedAt: new Date()
            };
            // Добавляем игрока (в память)
            players.push(player);
        }

        // Сохраняем / обновляем в БД
        try {
            upsertPlayerStmt.run({
                id: player.id,
                name: player.name,
                resources: player.resources,
                clickPower: player.clickPower,
                autoPower: player.autoPower,
                currentSkin: player.currentSkin,
                joinedAt: player.joinedAt
            });
        } catch (err) {
            console.error('DB upsert player error:', err);
        }
        
        // Отправляем обновленный список всем игрокам
        io.emit('players-update', players);
        
        // Уведомляем о новом игроке
        socket.broadcast.emit('player-joined', {
            name: playerName,
            resources: player.resources
        });
        
        // Отправляем текущему игроку его ID
        socket.emit('player-registered', {
            id: socket.id,
            name: playerName
        });
        
        console.log(`Игрок ${playerName} присоединился. Всего игроков: ${players.length}`);
    });

    // Обработчик обновления данных игрока
    socket.on('player-update', (playerData) => {
        const playerIndex = players.findIndex(p => p.id === socket.id);
        
        if (playerIndex !== -1) {
            players[playerIndex].resources = playerData.resources || players[playerIndex].resources;
            players[playerIndex].clickPower = playerData.clickPower || players[playerIndex].clickPower;
            players[playerIndex].autoPower = playerData.autoPower || players[playerIndex].autoPower;
            players[playerIndex].currentSkin = playerData.currentSkin || players[playerIndex].currentSkin;
            
            // Отправляем обновленный список всем
            io.emit('players-update', players);

            // Обновляем в БД
            try {
                updatePlayerResourcesStmt.run(players[playerIndex].resources, players[playerIndex].id);
                upsertPlayerStmt.run({
                    id: players[playerIndex].id,
                    name: players[playerIndex].name,
                    resources: players[playerIndex].resources,
                    clickPower: players[playerIndex].clickPower,
                    autoPower: players[playerIndex].autoPower,
                    currentSkin: players[playerIndex].currentSkin,
                    joinedAt: players[playerIndex].joinedAt
                });
            } catch (err) {
                console.error('DB update player error:', err);
            }
        }
    });

    // --- КЛАНЫ ---
    socket.on('create-clan', (data, cb) => {
        try {
            const name = String(data.name).trim();
            if (!name) return cb && cb({ ok: false, error: 'Invalid name' });
            const info = insertClanStmt.run(name, socket.id, new Date().toISOString());
            const clanId = info.lastInsertRowid;
            addClanMemberStmt.run(clanId, socket.id, 'owner');
            // return clan row
            const clan = db.prepare('SELECT * FROM clans WHERE id = ?').get(clanId);
            cb && cb({ ok: true, clan });
            // broadcast update
            io.emit('clans-updated');
        } catch (err) {
            console.error('create-clan error', err);
            // Handle UNIQUE constraint
            if (err && err.message && err.message.includes('UNIQUE')) {
                cb && cb({ ok: false, error: 'Клан с таким именем уже существует' });
            } else {
                cb && cb({ ok: false, error: String(err) });
            }
        }
    });

    socket.on('join-clan', (data, cb) => {
        try {
            const clanId = parseInt(data.clanId);
            if (!clanId) return cb && cb({ ok: false, error: 'Invalid clanId' });
            addClanMemberStmt.run(clanId, socket.id, 'member');
            cb && cb({ ok: true });
            io.emit('clans-updated');
        } catch (err) {
            console.error('join-clan error', err);
            cb && cb({ ok: false, error: String(err) });
        }
    });

    // Leave clan handler - removes the player from the clan_members table
    socket.on('leave-clan', (data, cb) => {
        try {
            const clanId = parseInt(data.clanId);
            if (!clanId) return cb && cb({ ok: false, error: 'Invalid clanId' });
            const del = db.prepare('DELETE FROM clan_members WHERE clanId = ? AND playerId = ?');
            del.run(clanId, socket.id);
            cb && cb({ ok: true });
            io.emit('clans-updated');
        } catch (err) {
            console.error('leave-clan error', err);
            cb && cb({ ok: false, error: String(err) });
        }
    });

    // --- ЕЖЕДНЕВНЫЕ ЗАДАНИЯ ---
    socket.on('claim-task', (data, cb) => {
        try {
            const taskId = parseInt(data.taskId);
            const playerId = socket.id;
            if (!taskId) return cb && cb({ ok: false, error: 'Invalid taskId' });

            // Проверяем, можно ли брать задачу (repeat_interval_days)
            const taskInfo = db.prepare('SELECT * FROM daily_tasks WHERE id = ?').get(taskId);
            if (!taskInfo) return cb && cb({ ok: false, error: 'Task not found' });

            const playerTask = getPlayerTaskStmt.get(playerId, taskId);
            const now = new Date();

            if (playerTask && playerTask.lastCompletedAt) {
                const last = new Date(playerTask.lastCompletedAt);
                const diffDays = Math.floor((now - last) / (1000 * 60 * 60 * 24));
                if (diffDays < (taskInfo.repeat_interval_days || 1)) {
                    return cb && cb({ ok: false, error: 'Задание уже выполнено. Повтор доступен позже.' });
                }
            }

            if (!playerTask) {
                insertPlayerTaskStmt.run(playerId, taskId, 'completed', now.toISOString());
            } else {
                updatePlayerTaskStmt.run('completed', now.toISOString(), playerId, taskId);
            }

            // Выдать награду
            const rewardInfo = db.prepare('SELECT reward FROM daily_tasks WHERE id = ?').get(taskId);
            if (rewardInfo) {
                const player = players.find(p => p.id === playerId);
                if (player) {
                    player.resources += rewardInfo.reward;
                    upsertPlayerStmt.run({
                        id: player.id,
                        name: player.name,
                        resources: player.resources,
                        clickPower: player.clickPower,
                        autoPower: player.autoPower,
                        currentSkin: player.currentSkin,
                        joinedAt: player.joinedAt
                    });
                    io.emit('players-update', players);
                }
            }

            cb && cb({ ok: true });
        } catch (err) {
            console.error('claim-task error', err);
            cb && cb({ ok: false, error: String(err) });
        }
    });

    // Обработчик сообщений чата
    socket.on('chat-message', (data) => {
        if (isValidMessage(data.message)) {
            // Добавляем отправителя из данных сокета
            const player = players.find(p => p.id === socket.id);
            if (player) {
                io.emit('chat-message', {
                    playerName: player.name,
                    message: data.message,
                    timestamp: new Date().toLocaleTimeString()
                });
            }
        }
    });

    // Обработчик запроса списка игроков
    socket.on('get-players', () => {
        socket.emit('players-update', players);
    });

    // Возвращает задачи для текущего игрока с полем claimable/status
    socket.on('get-my-tasks', (data, cb) => {
        try {
            const playerId = socket.id;
            const tasks = getDailyTasksStmt.all();
            const out = tasks.map(t => {
                const pt = getPlayerTaskStmt.get(playerId, t.id);
                let lastCompletedAt = pt ? pt.lastCompletedAt : null;
                let status = pt ? pt.status : 'pending';
                let claimable = true;
                if (lastCompletedAt) {
                    const last = new Date(lastCompletedAt);
                    const diffDays = Math.floor((Date.now() - last) / (1000 * 60 * 60 * 24));
                    if (diffDays < (t.repeat_interval_days || 1)) {
                        claimable = false;
                    }
                }
                return { ...t, status, lastCompletedAt, claimable };
            });
            cb && cb({ ok: true, tasks: out });
        } catch (err) {
            console.error('get-my-tasks error', err);
            cb && cb({ ok: false, error: String(err) });
        }
    });

    // ========== ОБРАБОТЧИКИ БАТТЛОВ ==========

    // Вызов игрока на баттл
    socket.on('battle-challenge', (data) => {
        const challenger = players.find(p => p.id === socket.id);
        const targetPlayer = players.find(p => p.id === data.targetId);

        if (!challenger || !targetPlayer) {
            socket.emit('battle-error', { message: 'Игрок не найден' });
            return;
        }

        if (challenger.id === targetPlayer.id) {
            socket.emit('battle-error', { message: 'Нельзя вызвать самого себя' });
            return;
        }

        if (challenger.inBattle || targetPlayer.inBattle) {
            socket.emit('battle-error', { message: 'Один из игроков уже в баттле' });
            return;
        }

        if (challenger.resources < BATTLE_CONFIG.ATTACK_COST) {
            socket.emit('battle-error', { message: 'Недостаточно рыбок для баттла' });
            return;
        }

        // Отправляем вызов целевому игроку
        io.to(targetPlayer.id).emit('battle-challenge', {
            challenger: {
                id: challenger.id,
                name: challenger.name,
                resources: challenger.resources
            },
            challengeId: 'challenge_' + Date.now()
        });

        socket.emit('battle-message', { message: `Вызов отправлен игроку ${targetPlayer.name}` });
    });

    // Принятие вызова на баттл
    socket.on('battle-accept', (data) => {
        const acceptor = players.find(p => p.id === socket.id);
        const challenger = players.find(p => p.id === data.challengerId);

        if (!acceptor || !challenger) {
            socket.emit('battle-error', { message: 'Игрок не найден' });
            return;
        }

        if (acceptor.inBattle || challenger.inBattle) {
            socket.emit('battle-error', { message: 'Один из игроков уже в баттле' });
            return;
        }

        if (acceptor.resources < BATTLE_CONFIG.ATTACK_COST) {
            socket.emit('battle-error', { message: 'Недостаточно рыбок для баттла' });
            return;
        }

        // Создаем новый баттл
        const battle = new Battle(challenger, acceptor);
        battles.push(battle);

        // Обновляем статус игроков
        challenger.inBattle = true;
        challenger.battleId = battle.id;
        acceptor.inBattle = true;
        acceptor.battleId = battle.id;

        // Отправляем уведомление о начале баттла
        io.to(challenger.id).emit('battle-start', battle.getBattleData());
        io.to(acceptor.id).emit('battle-start', battle.getBattleData());

        // Запускаем таймер первого хода
        battle.startTurnTimer();

        // Уведомляем всех о начале баттла
        io.emit('chat-message', {
            playerName: 'Система',
            message: `Начался баттл между ${challenger.name} и ${acceptor.name}!`,
            timestamp: new Date().toLocaleTimeString()
        });

        console.log(`Баттл начался: ${challenger.name} vs ${acceptor.name}`);
    });

    // Отклонение вызова на баттл
    socket.on('battle-decline', (data) => {
        const decliner = players.find(p => p.id === socket.id);
        const challenger = players.find(p => p.id === data.challengerId);

        if (challenger) {
            io.to(challenger.id).emit('battle-declined', {
                playerName: decliner.name,
                reason: data.reason || 'Игрок отклонил вызов'
            });
        }
    });

    // Выполнение атаки в баттле
    socket.on('battle-attack', (data) => {
        const player = players.find(p => p.id === socket.id);
        const battle = battles.find(b => b.id === data.battleId);

        if (!player || !battle) {
            socket.emit('battle-error', { message: 'Баттл не найден' });
            return;
        }

        if (!battle.isParticipant(player.id)) {
            socket.emit('battle-error', { message: 'Вы не участник этого баттла' });
            return;
        }

        if (battle.status !== 'active') {
            socket.emit('battle-error', { message: 'Баттл уже завершен' });
            return;
        }

        const action = battle.performAttack(player.id, data.isSpecial);

        if (action) {
            // Отправляем обновление баттла
            battle.broadcastBattleUpdate();

            // Уведомляем в чате о специальной атаке
            if (data.isSpecial) {
                io.emit('chat-message', {
                    playerName: 'Система',
                    message: `${player.name} использует супер-удар в баттле!`,
                    timestamp: new Date().toLocaleTimeString()
                });
            }
        } else {
            socket.emit('battle-error', { message: 'Не удалось выполнить атаку' });
        }
    });

    // Отмена баттла
    socket.on('battle-cancel', (data) => {
        const player = players.find(p => p.id === socket.id);
        const battle = battles.find(b => b.id === data.battleId);

        if (!player || !battle) {
            socket.emit('battle-error', { message: 'Баттл не найден' });
            return;
        }

        if (!battle.isParticipant(player.id)) {
            socket.emit('battle-error', { message: 'Вы не участник этого баттла' });
            return;
        }

        battle.cancelBattle(data.reason || 'Баттл отменен участником');

        // Освобождаем игроков
        battle.players.forEach(battlePlayer => {
            const playerIndex = players.findIndex(p => p.id === battlePlayer.id);
            if (playerIndex !== -1) {
                players[playerIndex].inBattle = false;
                players[playerIndex].battleId = null;
            }
        });

        // Удаляем баттл из списка
        battles = battles.filter(b => b.id !== battle.id);

        // Обновляем список игроков
        io.emit('players-update', players);
    });

    // Запрос информации о баттле
    socket.on('battle-info', (data) => {
        const battle = battles.find(b => b.id === data.battleId);
        const player = players.find(p => p.id === socket.id);

        if (battle && player && battle.isParticipant(player.id)) {
            socket.emit('battle-update', battle.getBattleData());
        }
    });

    // ========== КОНЕЦ ОБРАБОТЧИКОВ БАТТЛОВ ==========

    // Обработчик отключения игрока
    socket.on('disconnect', (reason) => {
        console.log('Игрок отключился:', socket.id, 'Причина:', reason);
        
        // Отменяем все баттлы с участием этого игрока
        const playerBattles = battles.filter(b => b.isParticipant(socket.id));
        
        playerBattles.forEach(battle => {
            battle.cancelBattle(`Игрок ${socket.id} отключился`);
            
            // Освобождаем другого игрока
            const opponent = battle.getOpponent(socket.id);
            if (opponent) {
                const opponentIndex = players.findIndex(p => p.id === opponent.id);
                if (opponentIndex !== -1) {
                    players[opponentIndex].inBattle = false;
                    players[opponentIndex].battleId = null;
                }
                
                // Уведомляем оппонента
                io.to(opponent.id).emit('battle-cancelled', {
                    reason: 'Противник отключился',
                    battleId: battle.id
                });
            }
        });

        // Удаляем баттлы с участием этого игрока
        battles = battles.filter(b => !b.isParticipant(socket.id));
        
        const playerIndex = players.findIndex(p => p.id === socket.id);
        
        if (playerIndex !== -1) {
            const disconnectedPlayer = players[playerIndex];
            players.splice(playerIndex, 1);
            
            // Отправляем обновленный список
            io.emit('players-update', players);
            
            // Уведомляем о выходе игрока
            socket.broadcast.emit('player-left', {
                name: disconnectedPlayer.name
            });
            
            console.log(`Игрок ${disconnectedPlayer.name} покинул игру. Осталось: ${players.length}`);
        }
    });

    // Обработчик ошибок
    socket.on('error', (error) => {
        console.error('Ошибка сокета:', error);
    });
});

// Проверка сообщения на валидность
function isValidMessage(message) {
    if (!message || typeof message !== 'string' || message.length > 200) return false;
    
    const forbiddenWords = ['спам', 'оскорбление', 'реклама'];
    const lowerMessage = message.toLowerCase();
    
    for (let word of forbiddenWords) {
        if (lowerMessage.includes(word)) return false;
    }
    
    // Проверяем на спам-ссылки
    const urlRegex = /(http|https):\/\/[^\s]+/g;
    if (urlRegex.test(lowerMessage)) return false;
    
    return true;
}

// Эндпоинт для проверки статуса сервера
app.get('/status', (req, res) => {
    res.json({
        status: 'online',
        players: players.length,
        battles: battles.length,
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// Эндпоинт для получения списка игроков
app.get('/players', (req, res) => {
    res.json({
        players: players.map(p => ({
            id: p.id,
            name: p.name,
            resources: p.resources,
            inBattle: p.inBattle,
            online: true
        })),
        total: players.length
    });
});

// Эндпоинт лидеров (leaderboard)
app.get('/leaderboard', (req, res) => {
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    try {
        const rows = getTopPlayersStmt.all(limit);
        res.json({ ok: true, leaderboard: rows });
    } catch (err) {
        console.error('leaderboard error', err);
        res.status(500).json({ ok: false, error: String(err) });
    }
});

// Эндпоинты для кланов
app.get('/clans', (req, res) => {
    try {
        const clans = getClansStmt.all();
        const result = clans.map(c => {
            const members = getClanMembersStmt.all(c.id);
            return { ...c, members };
        });
        res.json({ ok: true, clans: result });
    } catch (err) {
        console.error('clans error', err);
        res.status(500).json({ ok: false, error: String(err) });
    }
});

// Эндпоинт ежедневных заданий
app.get('/daily-tasks', (req, res) => {
    try {
        const tasks = getDailyTasksStmt.all();
        res.json({ ok: true, tasks });
    } catch (err) {
        console.error('daily-tasks error', err);
        res.status(500).json({ ok: false, error: String(err) });
    }
});

// Эндпоинт для получения списка активных баттлов
app.get('/battles', (req, res) => {
    res.json({
        battles: battles.map(battle => ({
            id: battle.id,
            player1: battle.player1.name,
            player2: battle.player2.name,
            turn: battle.turn,
            status: battle.status
        })),
        total: battles.length
    });
});

// Endpoint to get player's position in leaderboard by resources
app.get('/player-position', (req, res) => {
    const playerId = req.query.id;
    try {
        // get all players ordered by resources desc
        const rows = db.prepare('SELECT id, name, resources FROM players ORDER BY resources DESC').all();
        const total = rows.length;
        const index = rows.findIndex(r => r.id === playerId);
        if (index === -1) return res.json({ ok: true, position: null, total });
        return res.json({ ok: true, position: index + 1, total, player: rows[index] });
    } catch (err) {
        console.error('player-position error', err);
        res.status(500).json({ ok: false, error: String(err) });
    }
});

// Запуск сервера
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📍 Статус сервера: http://localhost:${PORT}/status`);
    console.log(`👥 Игроки онлайн: http://localhost:${PORT}/players`);
    console.log(`⚔️  Активные баттлы: http://localhost:${PORT}/battles`);
});