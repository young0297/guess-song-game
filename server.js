const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// 支援的音樂格式
const AUDIO_EXT = ['.mp3', '.flac', '.wav', '.ogg', '.m4a'];

let songs = [];

// 遞迴掃描資料夾
function scanAudioDir(dir, baseUrl = '/audio') {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            scanAudioDir(fullPath, `${baseUrl}/${entry.name}`);
        } else {
            const ext = path.extname(entry.name).toLowerCase();
            if (!AUDIO_EXT.includes(ext)) continue;

            const title = path.basename(entry.name, ext);

            songs.push({
                title,
                audioUrl: `${baseUrl}/${entry.name}`
            });
        }
    }
}

function initSongDatabase() {
    songs = [];
    const audioRoot = path.join(__dirname, 'public', 'audio');
    scanAudioDir(audioRoot);
    console.log(`Loaded ${songs.length} songs`);
}

initSongDatabase();

// 工具：洗牌
function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
}

// 產生 1 正確 + 3 錯誤選項
function generateOptions(correctTitle) {
    const titles = songs.map(s => s.title).filter(t => t !== correctTitle);

    shuffle(titles);
    const wrong = titles.slice(0, 3);

    const options = [correctTitle, ...wrong];
    shuffle(options);

    return {
        options,
        correctIndex: options.indexOf(correctTitle)
    };
}

// 房間
const rooms = new Map();

function getOrCreateRoom(roomId) {
    if (!rooms.has(roomId)) {
        rooms.set(roomId, {
            id: roomId,
            hostId: null,
            players: {},
            gameQuestions: [],
            gameIndex: 0,
            currentQuestion: null,
            roundActive: false
        });
    }
    return rooms.get(roomId);
}

// —— 遊戲自動流程（10 題） ——
function startNextRound(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    // 結束
    if (room.gameIndex >= room.gameQuestions.length) {
        io.to(roomId).emit('gameEnd', {
            players: room.players
        });
        return;
    }

    // 抽下一題
    const song = room.gameQuestions[room.gameIndex];
    room.gameIndex++;

    const { options, correctIndex } = generateOptions(song.title);

    room.currentQuestion = {
        title: song.title,
        audioUrl: song.audioUrl,
        correctIndex,
        winnerSocketId: null
    };

    room.roundActive = true;

    io.to(roomId).emit('question', {
        audioUrl: song.audioUrl,
        options,
        index: room.gameIndex,
        total: room.gameQuestions.length
    });
}

// —— WebSocket 連線 ——
io.on('connection', (socket) => {

    socket.on('joinRoom', ({ roomId, name }) => {
        const room = getOrCreateRoom(roomId);

        if (!room.hostId) room.hostId = socket.id;

        room.players[socket.id] = { name, score: 0 };
        socket.join(roomId);
        socket.data.roomId = roomId;

        io.to(roomId).emit('roomState', {
            roomId,
            hostId: room.hostId,
            players: room.players
        });
    });

    // 開始遊戲（10 題）
    socket.on('startGame', () => {
        const roomId = socket.data.roomId;
        const room = rooms.get(roomId);

        if (!room || room.hostId !== socket.id) return;

        // 建立隨機 10 題
        const shuffled = [...songs];
        shuffle(shuffled);

        room.gameQuestions = shuffled.slice(0, 10);
        room.gameIndex = 0;

        io.to(roomId).emit('gameStart', {
            total: room.gameQuestions.length
        });

        startNextRound(roomId);
    });

    // 玩家回答
    socket.on('answer', ({ optionIndex }) => {
        const roomId = socket.data.roomId;
        const room = rooms.get(roomId);
        const q = room?.currentQuestion;

        if (!room || !room.roundActive || !q) return;

        const player = room.players[socket.id];
        if (!player) return;

        const isCorrect = optionIndex === q.correctIndex;

        io.to(socket.id).emit('answerResult', { isCorrect });

        if (q.winnerSocketId) return;

        if (isCorrect) {
            q.winnerSocketId = socket.id;
            room.roundActive = false;
            player.score += 1;

            io.to(roomId).emit('roundResult', {
                correctIndex: q.correctIndex,
                winner: {
                    socketId: socket.id,
                    name: player.name,
                    score: player.score
                },
                players: room.players
            });

            // 3 秒後自動下一題
            setTimeout(() => {
                startNextRound(roomId);
            }, 3000);
        }
    });

    // 離線
    socket.on('disconnect', () => {
        const roomId = socket.data.roomId;
        const room = rooms.get(roomId);
        if (!room) return;

        delete room.players[socket.id];

        if (room.hostId === socket.id) {
            const ids = Object.keys(room.players);
            room.hostId = ids.length ? ids[0] : null;
        }

        if (Object.keys(room.players).length === 0) {
            rooms.delete(roomId);
        } else {
            io.to(roomId).emit('roomState', {
                roomId,
                hostId: room.hostId,
                players: room.players
            });
        }
    });

});

server.listen(3000, () => {
    console.log('🚀 Server running at http://localhost:3000');
});
