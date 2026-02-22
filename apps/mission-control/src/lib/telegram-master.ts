import { readIntegrationsStore } from "@/lib/integrations";
import { getDb } from "@/lib/db";
import { getOpenClawClient } from "@/lib/openclaw-client";

export class TelegramMasterMonitor {
    private running = false;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private offset = 0;

    start() {
        if (this.running) {return;}
        this.running = true;
        this.poll();
        console.log("[TelegramMaster] Started long-polling");
    }

    stop() {
        this.running = false;
        if (this.timer) {clearTimeout(this.timer);}
    }

    private async getToken() {
        const store = readIntegrationsStore();
        return store.telegram_master?.token;
    }

    private async poll() {
        if (!this.running) {return;}

        const token = await this.getToken();
        if (!token) {
            // Not configured yet, check again periodically
            this.timer = setTimeout(() => this.poll(), 30000);
            return;
        }

        try {
            const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${this.offset}&timeout=15`);
            if (res.ok) {
                const data = await res.json();
                if (data.ok && data.result.length > 0) {
                    for (const update of data.result) {
                        this.offset = update.update_id + 1;
                        if (update.message?.text) {
                            await this.handleMessage(token, update.message.chat.id, update.message.text);
                        }
                    }
                }
            } else if (res.status === 401 || res.status === 404) {
                // Invalid token, sleep longer
                this.timer = setTimeout(() => this.poll(), 60000);
                return;
            }
        } catch (err) {
            // Network error
        }

        // Loop immediately unless stopped
        this.timer = setTimeout(() => this.poll(), 1000);
    }

    private async sendMessage(token: string, chatId: number, text: string) {
        try {
            await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" })
            });
        } catch (e) {
            console.error("[TelegramMaster] Send error:", String(e));
        }
    }

    private async handleMessage(token: string, chatId: number, text: string) {
        const cmd = text.trim().toLowerCase();

        if (cmd === "/status") {
            const client = getOpenClawClient();
            const isUp = client.isConnected();
            const msg = `📡 <b>Gateway Status</b>: ${isUp ? "ONLINE ✅" : "OFFLINE ❌"}`;
            await this.sendMessage(token, chatId, msg);
        }
        else if (cmd === "/tasks") {
            const db = getDb();
            const tasks = db.prepare("SELECT id, title, status FROM tasks WHERE status IN ('in_progress', 'assigned') LIMIT 10").all() as any[];
            if (tasks.length === 0) {
                await this.sendMessage(token, chatId, "✨ No active tasks right now.");
            } else {
                const lines = tasks.map(t => `• <b>[${t.status}]</b> ${t.title}`);
                await this.sendMessage(token, chatId, `📋 <b>Active Tasks</b>:\n\n${lines.join("\n")}`);
            }
        }
        else if (cmd === "/logs") {
            const db = getDb();
            const logs = db.prepare("SELECT timestamp, level, message FROM application_logs ORDER BY timestamp DESC LIMIT 5").all() as any[];
            if (logs.length === 0) {
                await this.sendMessage(token, chatId, "📜 No recent logs found.");
            } else {
                const items = logs.map(l => `[${l.level}] ${l.message}`).join("\n");
                await this.sendMessage(token, chatId, `📜 <b>Recent Logs</b>:\n<pre>${items}</pre>`);
            }
        }
        else if (cmd === "/restart") {
            try {
                // Fetch to internal restart API
                await fetch("http://127.0.0.1:3000/api/openclaw/restart", { method: "POST" });
                await this.sendMessage(token, chatId, "🔄 Gateway restart API invoked.");
            } catch (e) {
                await this.sendMessage(token, chatId, `⚠️ Failed to restart: ${String(e)}`);
            }
        }
        else {
            await this.sendMessage(token, chatId, "🤖 <b>Mission Control</b> ready.\n\n<b>Commands</b>:\n/status - Gateway health\n/tasks - Active tasks\n/logs - View logs\n/restart - Restart gateway");
        }
    }

    /**
     * Broadcast an alert to the master chat (if a chat history exists, we infer the chat ID from DB or memory - simplified for now)
     */
    public async broadcastAlert(message: string) {
        const token = await this.getToken();
        if (!token) {return;}
        // Note: To broadcast, we need a saved chat_id. For v1, we can require the user to send `/start` first 
        // and we save it, OR we simply rely on reply to messages.
        // Let's print to console for now if broadcast is requested.
        console.log(`[TelegramMaster Alert] ${message}`);
    }
}

let monitor: TelegramMasterMonitor | null = null;
export function getTelegramMasterMonitor() {
    if (!monitor) {monitor = new TelegramMasterMonitor();}
    return monitor;
}
