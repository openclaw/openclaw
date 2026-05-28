// Notifier.mjs — 多管道通知系統
// 支援: LINE Notify / LINE Messaging API / Telegram Bot / Discord Webhook
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const axios = require("axios");
import { appendFileSync } from "node:fs";

const NOTIFY_LOG = "D:\\群益及元大API\\CapitalHftService\\state\\hft_notifications.jsonl";

// ── 格式化工具 ───────────────────────────────────
function dirEmoji(direction) {
  const map = {
    buy: "📈",
    sell: "📉",
    close_long: "🔴",
    close_short: "🟢",
    open_spread: "🔀",
    close_spread: "✅",
    triangular: "💰",
  };
  return map[direction] ?? "📌";
}

function formatSignal(sig) {
  const emoji = dirEmoji(sig.direction ?? sig.type);
  const time = new Date(sig.time ?? Date.now()).toLocaleTimeString("zh-TW", { hour12: false });
  if (sig.type === "spread") {
    return (
      `${emoji} [${sig.strategy}] ${sig.direction}\n` +
      `  Leg A: ${sig.legA?.direction?.toUpperCase()} ${sig.legA?.instrument}\n` +
      `  Leg B: ${sig.legB?.direction?.toUpperCase()} ${sig.legB?.instrument}\n` +
      `  ${sig.reason ?? ""}\n  @${time}`
    );
  }
  return (
    `${emoji} [${sig.strategy}] ${(sig.direction ?? "").toUpperCase()} ` +
    `${sig.instrument ?? ""} qty=${sig.qty ?? ""}\n  ${sig.reason ?? ""}\n  @${time}`
  );
}

function formatPosition(positions) {
  if (!positions?.length) {
    return "目前無持倉";
  }
  return positions
    .map((p) => {
      const side = p.LongQty > 0 ? `多${p.LongQty}口` : `空${p.ShortQty}口`;
      return `${p.StockNo} ${side} 均成本=${p.LongAvgCost ?? p.ShortAvgCost ?? 0} 未實現=${p.UnrealizedPnl?.toFixed(0) ?? 0}`;
    })
    .join("\n");
}

// ══════════════════════════════════════════════
// LINE Notify（舊版，最簡單）
// ══════════════════════════════════════════════
export class LineNotify {
  constructor(token) {
    this.token = token;
    this.url = "https://notify-api.line.me/api/notify";
  }
  async send(message, imageUrl = null) {
    if (!this.token || this.token === "YOUR_LINE_NOTIFY_TOKEN") {
      return;
    }
    const data = new URLSearchParams({ message });
    if (imageUrl) {
      data.append("imageThumbnail", imageUrl);
    }
    try {
      await axios.post(this.url, data.toString(), {
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: 8000,
      });
    } catch (e) {
      console.warn("[LINE Notify]", e.message);
    }
  }
}

// ══════════════════════════════════════════════
// LINE Messaging API（新版，支援圖片/按鈕）
// ══════════════════════════════════════════════
export class LineMessaging {
  constructor(channelAccessToken, userId) {
    this.token = channelAccessToken;
    this.userId = userId;
    this.url = "https://api.line.me/v2/bot/message/push";
  }
  async send(text) {
    if (!this.token || this.token === "YOUR_CHANNEL_ACCESS_TOKEN") {
      return;
    }
    try {
      await axios.post(
        this.url,
        {
          to: this.userId,
          messages: [{ type: "text", text }],
        },
        {
          headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
          timeout: 8000,
        },
      );
    } catch (e) {
      console.warn("[LINE Messaging]", e.message);
    }
  }
}

// ══════════════════════════════════════════════
// Telegram Bot
// ══════════════════════════════════════════════
export class TelegramNotifier {
  constructor(botToken, chatId) {
    this.botToken = botToken;
    this.chatId = chatId;
  }
  async send(text, parseMode = "HTML") {
    if (!this.botToken || this.botToken === "YOUR_BOT_TOKEN") {
      return;
    }
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    try {
      await axios.post(
        url,
        {
          chat_id: this.chatId,
          text,
          parse_mode: parseMode,
        },
        { timeout: 8000 },
      );
    } catch (e) {
      console.warn("[Telegram]", e.message);
    }
  }
  async sendChart(photoUrl, caption) {
    if (!this.botToken || this.botToken === "YOUR_BOT_TOKEN") {
      return;
    }
    const url = `https://api.telegram.org/bot${this.botToken}/sendPhoto`;
    try {
      await axios.post(url, { chat_id: this.chatId, photo: photoUrl, caption }, { timeout: 10000 });
    } catch (e) {
      console.warn("[Telegram sendPhoto]", e.message);
    }
  }
}

// ══════════════════════════════════════════════
// Discord Webhook
// ══════════════════════════════════════════════
export class DiscordNotifier {
  constructor(webhookUrl) {
    this.webhookUrl = webhookUrl;
  }
  async send(content, embeds = []) {
    if (!this.webhookUrl || this.webhookUrl === "YOUR_WEBHOOK_URL") {
      return;
    }
    try {
      await axios.post(this.webhookUrl, { content, embeds }, { timeout: 8000 });
    } catch (e) {
      console.warn("[Discord]", e.message);
    }
  }
  async sendEmbed(title, description, color = 0x00ff99, fields = []) {
    await this.send("", [
      { title, description, color, fields, timestamp: new Date().toISOString() },
    ]);
  }
}

// ══════════════════════════════════════════════
// 統一通知管理器（聚合所有管道）
// ══════════════════════════════════════════════
export class NotifyManager {
  constructor(config = {}) {
    this._channels = [];

    if (config.lineNotifyToken && config.lineNotifyToken !== "YOUR_LINE_NOTIFY_TOKEN") {
      this._channels.push(new LineNotify(config.lineNotifyToken));
    }

    if (config.lineChannelToken && config.lineUserId) {
      this._channels.push(new LineMessaging(config.lineChannelToken, config.lineUserId));
    }

    if (config.telegramToken && config.telegramChatId) {
      this._channels.push(new TelegramNotifier(config.telegramToken, config.telegramChatId));
    }

    if (config.discordWebhook && config.discordWebhook !== "YOUR_WEBHOOK_URL") {
      this._channels.push(new DiscordNotifier(config.discordWebhook));
    }

    // 過濾設定
    this.onlyAuto = config.onlyAuto ?? false; // true=只推自動執行的信號
    this.minQty = config.minQty ?? 0; // 最小口數才推送
    this.cooldownMs = config.cooldownMs ?? 2000; // 防重複推送
    this._lastNotifyAt = {};

    console.log(`[Notifier] 已啟用 ${this._channels.length} 個通知管道`);
  }

  /** 推送交易信號 */
  async signal(sig) {
    if (this.onlyAuto && !sig.autoExecute) {
      return;
    }
    if ((sig.qty ?? 0) < this.minQty) {
      return;
    }

    const key = `${sig.strategy}_${sig.direction}`;
    if (Date.now() - (this._lastNotifyAt[key] ?? 0) < this.cooldownMs) {
      return;
    }
    this._lastNotifyAt[key] = Date.now();

    const text = formatSignal(sig);
    this._log({ type: "signal", sig, sentAt: new Date().toISOString() });
    await this._broadcast(text, sig);
  }

  /** 推送每日績效摘要 */
  async dailySummary(stats) {
    const pnlEmoji = stats.totalPnl >= 0 ? "🟢" : "🔴";
    const text =
      `📊 每日績效摘要\n` +
      `${pnlEmoji} 總損益: ${stats.totalPnl?.toFixed(2) ?? 0}\n` +
      `✅ 勝率: ${((stats.winRate ?? 0) * 100).toFixed(1)}%\n` +
      `📈 總信號: ${stats.totalSignals ?? 0}\n` +
      `💹 夏普比率: ${stats.sharpe?.toFixed(2) ?? "N/A"}\n` +
      `📉 最大回撤: ${stats.maxDrawdown?.toFixed(2) ?? 0}\n` +
      `\n持倉:\n${formatPosition(stats.positions)}`;
    await this._broadcast(text, null);
  }

  /** 推送風控警告 */
  async riskAlert(message, level = "WARN") {
    const emoji = level === "KILL" ? "🚨⛔" : level === "ERROR" ? "🔴" : "⚠️";
    const text = `${emoji} [風控${level}] ${message}`;
    await this._broadcast(text, null);
  }

  /** 推送系統狀態 */
  async systemStatus(message) {
    await this._broadcast(`🖥️ ${message}`, null);
  }

  async _broadcast(text, sig) {
    await Promise.allSettled(
      this._channels.map(async (ch) => {
        if (ch instanceof DiscordNotifier && sig) {
          const color =
            sig.direction === "buy" ? 0x00ff00 : sig.direction === "sell" ? 0xff0000 : 0xffaa00;
          await ch.sendEmbed(
            `${dirEmoji(sig.direction ?? "")} ${sig.strategy ?? ""}`,
            text,
            color,
            sig.instrument
              ? [
                  { name: "商品", value: sig.instrument, inline: true },
                  { name: "方向", value: sig.direction ?? "", inline: true },
                ]
              : [],
          );
        } else {
          await ch.send(text);
        }
      }),
    );
  }

  _log(entry) {
    try {
      appendFileSync(NOTIFY_LOG, JSON.stringify(entry) + "\n");
    } catch {}
  }
}
