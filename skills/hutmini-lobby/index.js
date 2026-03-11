const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const LOBBY_URL = "https://ai.hutmini.com/api/pairing";
const WS_URL = "wss://ai.hutmini.com/api/ws";
const TOKEN_FILE = path.join(__dirname, ".lobby_token.json");

async function pairAgent(code) {
    console.log(`[LOBBY] 正在尝试使用代码配对: ${code}...`);
    try {
        const response = await fetch(LOBBY_URL);
        if (response.ok) {
            const data = await response.json();
            if (data.code === code) {
                console.log("[LOBBY] 🎉 配对成功！Agent 已接入 Hutmini Web 大厅。");
                fs.writeFileSync(TOKEN_FILE, JSON.stringify({ paired: true, code, timestamp: Date.now() }, null, 2));
                return true;
            } else {
                console.log("[LOBBY] ❌ 配对失败。验证码无效或已过期。");
            }
        } else {
            console.log("[LOBBY] ❌ 服务器错误。");
        }
    } catch (error) {
        console.log(`[LOBBY] ❌ 连接错误: ${error.message}`);
    }
    return false;
}

function listenForTasks() {
    if (!fs.existsSync(TOKEN_FILE)) {
        console.log("[LOBBY] ❌ Agent 未配对。请先运行 --pair <CODE> 进行身份验证。");
        return;
    }

    const tokenData = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    const ws = new WebSocket(WS_URL);

    ws.on('open', () => {
        console.log("[LOBBY] 📡 已通过 WebSocket 连接到 Hutmini 云端大厅。");
        ws.send(JSON.stringify({
            type: "register",
            code: tokenData.code
        }));
    });

    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            if (message.type === "registered") {
                console.log("[LOBBY] ✅ 握手完成。当前状态: 在线");
            } else if (message.type === "dispatch_task") {
                console.log(`[LOBBY] 🚀 收到新任务: ${message.task.name}`);
                console.log(`[LOBBY] 🛠️ 正在执行操作: ${message.task.action}...`);

                // 咨询云端 AI 获取策略
                try {
                    const proxyResponse = await fetch("http://localhost:3000/api/proxy", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            model: "gpt-4o",
                            messages: [{ role: "user", content: `请为任务 "${message.task.name}" 制定执行计划` }]
                        })
                    });

                    const aiResult = await proxyResponse.json();
                    console.log(`[LOBBY] 💡 AI 执行建议: ${aiResult.choices[0].message.content}`);

                    // 模拟工作执行
                    setTimeout(() => {
                        console.log(`[LOBBY] ✅ 任务 ${message.task.id} 执行完毕。`);
                        ws.send(JSON.stringify({
                            type: "task_result",
                            taskId: message.task.id,
                            result: {
                                status: "success",
                                output: aiResult.choices[0].message.content
                            }
                        }));
                    }, 2000);
                } catch (err) {
                    console.error("[LOBBY] ❌ AI 代理请求失败:", err.message);
                }
            }
        } catch (e) {
            console.log("[LOBBY] ❌ 消息解析失败");
        }
    });

    ws.on('close', () => {
        console.log("[LOBBY] 🔴 连接已断开。5秒后尝试重连...");
        setTimeout(listenForTasks, 5000);
    });

    ws.on('error', (err) => {
        console.error("[LOBBY] ❌ WebSocket 错误:", err.message);
    });

    setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "heartbeat" }));
        }
    }, 30000);
}

const args = process.argv.slice(2);
const pairIndex = args.indexOf('--pair');
const listenIndex = args.indexOf('--listen');

(async () => {
    if (pairIndex !== -1 && args[pairIndex + 1]) {
        await pairAgent(args[pairIndex + 1]);
    } else if (listenIndex !== -1) {
        listenForTasks();
    } else {
        console.log(`
Hutmini Lobby Connector (Lobster Skill Implementation)

用法:
  node index.js --pair <6位验证码>
  node index.js --listen
`);
    }
})();
