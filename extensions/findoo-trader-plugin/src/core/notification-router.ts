/**
 * Notification router — listens to AgentEventStore and dispatches
 * notifications to Telegram via OpenClaw's native sendMessageTelegram.
 *
 * For approval-required events (trade_pending), sends inline buttons
 * so users can approve/reject directly from Telegram.
 */

import type { sendMessageTelegram } from "openclaw/plugin-sdk/telegram";
import type { AgentEventSqliteStore } from "./agent-event-sqlite-store.js";
import type { AgentEvent, AgentEventType, EventSubscriber } from "./agent-event-store.js";

// ── Types ──

export type SendMessageTelegramFn = typeof sendMessageTelegram;

export type NotificationLevel = "critical" | "action_required" | "info";

export type NotificationConfig = {
  /** Telegram chat ID to send notifications to. */
  telegramChatId: string;
  /** Telegram bot token (falls back to TELEGRAM_BOT_TOKEN env var). */
  telegramBotToken?: string;
  /** Minimum level to notify. Defaults to "info". */
  minLevel?: NotificationLevel;
  /** Event types to suppress. */
  suppressTypes?: AgentEventType[];
  /** Base URL for approval callback. Defaults to gateway URL. */
  callbackBaseUrl?: string;
};

type EventNotification = {
  event: AgentEvent;
  level: NotificationLevel;
  text: string;
  buttons?: Array<Array<{ text: string; callback_data: string }>>;
};

// ── Level priority ──

const LEVEL_PRIORITY: Record<NotificationLevel, number> = {
  critical: 3,
  action_required: 2,
  info: 1,
};

// ── Event → notification level mapping ──

function resolveEventLevel(event: AgentEvent): NotificationLevel {
  switch (event.type) {
    case "emergency_stop":
      return "critical";
    case "trade_pending":
      return "action_required";
    case "trade_executed":
    case "order_filled":
    case "order_cancelled":
    case "strategy_promoted":
    case "strategy_killed":
    case "alert_triggered":
    case "system":
      return "info";
    default:
      return "info";
  }
}

// ── Emoji mapping ──

const EVENT_EMOJI: Record<AgentEventType, string> = {
  trade_executed: "\u2705",
  trade_pending: "\u23f3",
  alert_triggered: "\ud83d\udea8",
  strategy_promoted: "\ud83d\ude80",
  strategy_killed: "\u2620\ufe0f",
  order_filled: "\ud83d\udcb0",
  order_cancelled: "\u274c",
  emergency_stop: "\ud83d\udea8",
  system: "\u2139\ufe0f",
};

// ── Format notification text ──

function formatNotificationText(event: AgentEvent, level: NotificationLevel): string {
  const emoji = EVENT_EMOJI[event.type] ?? "\u2139\ufe0f";
  const levelTag =
    level === "critical" ? " [CRITICAL]" : level === "action_required" ? " [ACTION REQUIRED]" : "";
  const time = new Date(event.timestamp).toLocaleString("en-US", {
    timeZone: "UTC",
    hour12: false,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const lines = [
    `${emoji}<b>${levelTag} ${event.title}</b>`,
    ``,
    event.detail,
    ``,
    `<i>${time} UTC | ${event.type} | ${event.id}</i>`,
  ];
  return lines.join("\n");
}

// ── Build notification ──

function buildNotification(event: AgentEvent): EventNotification {
  const level = resolveEventLevel(event);
  const text = formatNotificationText(event, level);

  // For pending trades, add approve/reject inline buttons
  if (event.type === "trade_pending" && event.status === "pending") {
    return {
      event,
      level,
      text,
      buttons: [
        [
          { text: "\u2705 Approve", callback_data: `fin_approve:${event.id}` },
          { text: "\u274c Reject", callback_data: `fin_reject:${event.id}` },
        ],
      ],
    };
  }

  return { event, level, text };
}

// ── Router ──

export class NotificationRouter {
  private unsubscribe: (() => void) | null = null;
  private config: NotificationConfig;
  private sendFn: SendMessageTelegramFn;
  private sendCount = 0;
  private errorCount = 0;

  /** Try to resolve chat ID from config or Telegram getUpdates API. */
  static async resolveChatId(config: NotificationConfig): Promise<string | undefined> {
    if (config.telegramChatId) return config.telegramChatId;

    const token = config.telegramBotToken ?? process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return undefined;

    try {
      const resp = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=1`);
      if (!resp.ok) return undefined;
      const data = (await resp.json()) as {
        ok: boolean;
        result: Array<{ message?: { chat?: { id: number } } }>;
      };
      if (data.ok && data.result?.[0]?.message?.chat?.id) {
        return String(data.result[0].message.chat.id);
      }
    } catch {
      // Silently degrade — no chat_id available
    }
    return undefined;
  }

  constructor(
    private eventStore: AgentEventSqliteStore,
    config: NotificationConfig,
    sendFn: SendMessageTelegramFn,
  ) {
    this.config = {
      minLevel: "info",
      ...config,
    };
    this.sendFn = sendFn;
  }

  /** Start listening for events and routing notifications. */
  start(): void {
    if (this.unsubscribe) return;

    const handler: EventSubscriber = (event) => {
      // Fire and forget — don't block the event store
      void this.route(event);
    };

    this.unsubscribe = this.eventStore.subscribe(handler);
  }

  /** Stop listening for events. */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /** Get stats for diagnostics. */
  getStats(): { sendCount: number; errorCount: number; running: boolean } {
    return {
      sendCount: this.sendCount,
      errorCount: this.errorCount,
      running: this.unsubscribe !== null,
    };
  }

  /** Route a single event to the appropriate notification channel. */
  private async route(event: AgentEvent): Promise<void> {
    // Skip system notification events generated by approve/reject
    if (event.type === "system") return;

    // Check suppression list
    if (this.config.suppressTypes?.includes(event.type)) return;

    const notification = buildNotification(event);

    // Check minimum level
    const minPriority = LEVEL_PRIORITY[this.config.minLevel ?? "info"];
    if (LEVEL_PRIORITY[notification.level] < minPriority) return;

    await this.sendTelegramNotification(notification);
  }

  /** Send a notification via OpenClaw's native Telegram sender. */
  private async sendTelegramNotification(notification: EventNotification): Promise<void> {
    const { telegramChatId, telegramBotToken } = this.config;
    if (!telegramChatId) return;

    try {
      await this.sendFn(telegramChatId, notification.text, {
        token: telegramBotToken,
        textMode: "html",
        buttons: notification.buttons,
      });
      this.sendCount++;
    } catch (err) {
      this.errorCount++;
      // ARCH_LIMITATION: No structured plugin logger available at this layer.
      // The notification failure is silently counted. Production deployment
      // should monitor errorCount via the /api/v1/finance/notifications/stats endpoint.
      console.error(
        `[notification-router] Failed to send Telegram notification for ${notification.event.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

// ── Exports for testing ──

export { resolveEventLevel, formatNotificationText, buildNotification };
