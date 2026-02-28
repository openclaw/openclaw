/**
 * Comms Agent
 *
 * Handles Telegram notifications, voice calls, and escalation management
 * with anti-spam controls and message history tracking.
 */

import type { OpenClawPluginApi } from "../../../../src/plugins/types.js";
import { getDatabase, type Database } from "../db/database.js";
import { type MessagePriority, type BCLMessage } from "../types/index.js";

export type DeliveryStatus = "pending" | "sent" | "delivered" | "failed";

export interface CommsMessage extends BCLMessage {
  recipient?: string;
  deliveryStatus: DeliveryStatus;
  errorMessage?: string;
  telegramMessageId?: number;
}

export interface EscalationConfig {
  critical: { autoEscalate: boolean; notifyChannels: string[] };
  high: { autoEscalate: boolean; notifyChannels: string[] };
  normal: { autoEscalate: boolean; notifyChannels: string[] };
  low: { autoEscalate: boolean; notifyChannels: string[] };
}

const DEFAULT_ESCALATION_CONFIG: EscalationConfig = {
  critical: { autoEscalate: true, notifyChannels: ["telegram", "voice"] },
  high: { autoEscalate: true, notifyChannels: ["telegram"] },
  normal: { autoEscalate: false, notifyChannels: ["telegram"] },
  low: { autoEscalate: false, notifyChannels: [] },
};

const PRIORITY_LEVELS: Record<MessagePriority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

const ANTI_SPAM_CONFIG = {
  maxMessagesPerDay: 3,
  allowedPriorities: ["critical", "high"] as MessagePriority[],
};

export class CommsAgent {
  private api: OpenClawPluginApi;
  private database: Database;
  private messageCount: number = 0;
  private lastMessageDate: Date | null = null;
  private escalationConfig: EscalationConfig;
  private telegramChatId?: string;

  constructor(api: OpenClawPluginApi, escalationConfig?: Partial<EscalationConfig>) {
    this.api = api;
    this.database = getDatabase();
    this.escalationConfig = { ...DEFAULT_ESCALATION_CONFIG, ...escalationConfig };
    this.initializeMessageTable();
    this.loadTelegramConfig();
  }

  private initializeMessageTable(): void {
    try {
      const db = this.database.getDb();
      db.exec(`
        CREATE TABLE IF NOT EXISTS comms_messages (
          id TEXT PRIMARY KEY,
          priority TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT,
          timestamp TEXT NOT NULL,
          sent INTEGER DEFAULT 0,
          delivery_status TEXT DEFAULT 'pending',
          recipient TEXT,
          error_message TEXT,
          telegram_message_id INTEGER
        );

        CREATE TABLE IF NOT EXISTS comms_daily_counts (
          date TEXT PRIMARY KEY,
          message_count INTEGER DEFAULT 0
        );
      `);
      this.api.logger.debug("Comms: Message tables initialized");
    } catch (error) {
      this.api.logger.error("Comms: Failed to initialize message tables" + String(error));
    }
  }

  private loadTelegramConfig(): void {
    try {
      const chatId = this.api.config.get("bcl.telegramChatId");
      if (chatId && typeof chatId === "string") {
        this.telegramChatId = chatId;
      } else {
        this.telegramChatId = process.env.BCL_TELEGRAM_CHAT_ID;
      }
    } catch {
      this.telegramChatId = process.env.BCL_TELEGRAM_CHAT_ID;
    }
  }

  async execute(): Promise<void> {
    this.api.logger.info("Comms Agent: Checking for notifications...");
    this.resetDailyCountIfNeeded();
  }

  private resetDailyCountIfNeeded(): void {
    const today = new Date().toISOString().split("T")[0];
    try {
      const db = this.database.getDb();
      const record = db
        .prepare("SELECT message_count FROM comms_daily_counts WHERE date = ?")
        .get(today) as { message_count: number } | undefined;
      this.messageCount = record?.message_count ?? 0;
      this.lastMessageDate = new Date();
    } catch (error) {
      this.api.logger.warn("Comms: Failed to reset daily count" + String(error));
      this.messageCount = 0;
    }
  }

  private updateDailyCount(): void {
    const today = new Date().toISOString().split("T")[0];
    try {
      const db = this.database.getDb();
      db.prepare(`
        INSERT INTO comms_daily_counts (date, message_count)
        VALUES (?, 1)
        ON CONFLICT(date) DO UPDATE SET
          message_count = message_count + 1
      `).run(today);
      this.messageCount++;
    } catch (error) {
      this.api.logger.warn("Comms: Failed to update daily count" + String(error));
    }
  }

  async sendMessage(
    priority: MessagePriority,
    title: string,
    body: string,
    recipient?: string,
  ): Promise<CommsMessage> {
    this.resetDailyCountIfNeeded();

    if (!this.shouldAllowMessage(priority)) {
      const message: CommsMessage = {
        id: this.generateMessageId(),
        priority,
        title,
        body,
        timestamp: new Date(),
        sent: false,
        deliveryStatus: "failed",
        recipient,
        errorMessage: "Message blocked by anti-spam policy",
      };
      this.saveMessageToDb(message);
      this.api.logger.warn(`Comms: Message blocked by anti-spam: ${title}`);
      return message;
    }

    const message: CommsMessage = {
      id: this.generateMessageId(),
      priority,
      title,
      body,
      timestamp: new Date(),
      sent: false,
      deliveryStatus: "pending",
      recipient,
    };

    try {
      await this.sendTelegramMessage(message);
      message.sent = true;
      message.deliveryStatus = "sent";
      this.updateDailyCount();
      this.api.logger.info(`Comms: Sent ${priority} message: ${title}`);
    } catch (error) {
      message.deliveryStatus = "failed";
      message.errorMessage = error instanceof Error ? error.message : String(error);
      this.api.logger.error(`Comms: Failed to send message: ${title}` + String(error));
    }

    this.saveMessageToDb(message);
    return message;
  }

  private shouldAllowMessage(priority: MessagePriority): boolean {
    if (this.messageCount >= ANTI_SPAM_CONFIG.maxMessagesPerDay) {
      this.api.logger.warn(
        `Comms: Daily message limit reached (${ANTI_SPAM_CONFIG.maxMessagesPerDay})`,
      );
      return false;
    }

    if (!ANTI_SPAM_CONFIG.allowedPriorities.includes(priority)) {
      this.api.logger.info(`Comms: Skipping ${priority} priority message (anti-spam)`);
      return false;
    }

    return true;
  }

  private async sendTelegramMessage(message: CommsMessage): Promise<void> {
    const chatId =
      this.telegramChatId || (this.api.config.get("telegram.chatId") as string | undefined);

    if (!chatId) {
      throw new Error(
        "Telegram chat ID not configured. Set bcl.telegramChatId or BCL_TELEGRAM_CHAT_ID",
      );
    }

    const formattedMessage = this.formatTelegramMessage(message);

    try {
      const result = await this.api.runtime.telegram.sendMessageTelegram({
        chatId,
        text: formattedMessage,
        parseMode: "Markdown",
      });

      if (result && result.message_id) {
        message.telegramMessageId = result.message_id;
        message.deliveryStatus = "delivered";
      }
    } catch (error) {
      this.api.logger.error("Comms: Telegram send failed" + String(error));
      throw error;
    }
  }

  private formatTelegramMessage(message: CommsMessage): string {
    const priorityEmoji = this.getPriorityEmoji(message.priority);
    const escapeMarkdown = (text: string) => text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");

    return `${priorityEmoji} *${escapeMarkdown(message.title)}*\n\n${escapeMarkdown(message.body)}\n\n_${message.priority.toUpperCase()} | ${message.timestamp.toISOString()}_`;
  }

  private getPriorityEmoji(priority: MessagePriority): string {
    switch (priority) {
      case "critical":
        return "🔴";
      case "high":
        return "🟠";
      case "normal":
        return "🟡";
      case "low":
        return "🟢";
    }
  }

  async sendVoiceCall(
    message: string,
    phoneNumber?: string,
  ): Promise<{ success: boolean; callId?: string; error?: string }> {
    this.resetDailyCountIfNeeded();

    if (!this.shouldAllowMessage("critical")) {
      this.api.logger.warn("Comms: Voice call blocked by anti-spam policy");
      return { success: false, error: "Voice call blocked by anti-spam policy" };
    }

    try {
      const recipient = phoneNumber || process.env.BCL_VOICE_PHONE_NUMBER;
      if (!recipient) {
        throw new Error("Phone number not configured. Set BCL_VOICE_PHONE_NUMBER");
      }

      await this.api.runtime.tts.textToSpeechTelephony({
        phoneNumber: recipient,
        text: message,
      });

      this.updateDailyCount();
      this.api.logger.info(`Comms: Voice call initiated to ${recipient}`);

      return { success: true, callId: `call_${Date.now()}` };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.api.logger.error("Comms: Voice call failed" + String(error));
      return { success: false, error: errorMessage };
    }
  }

  async getMessageHistory(limit: number = 50, priority?: MessagePriority): Promise<CommsMessage[]> {
    try {
      const db = this.database.getDb();
      let query = "SELECT * FROM comms_messages";
      const params: string[] = [];

      if (priority) {
        query += " WHERE priority = ?";
        params.push(priority);
      }

      query += " ORDER BY timestamp DESC LIMIT ?";
      params.push(String(limit));

      const rows = db.prepare(query).all(...params) as Array<{
        id: string;
        priority: MessagePriority;
        title: string;
        body: string;
        timestamp: string;
        sent: number;
        delivery_status: DeliveryStatus;
        recipient: string | null;
        error_message: string | null;
        telegram_message_id: number | null;
      }>;

      return rows.map((row) => ({
        id: row.id,
        priority: row.priority,
        title: row.title,
        body: row.body,
        timestamp: new Date(row.timestamp),
        sent: row.sent === 1,
        deliveryStatus: row.delivery_status,
        recipient: row.recipient || undefined,
        errorMessage: row.error_message || undefined,
        telegramMessageId: row.telegram_message_id || undefined,
      }));
    } catch (error) {
      this.api.logger.error("Comms: Failed to get message history" + String(error));
      return [];
    }
  }

  getEscalationLevel(priority: MessagePriority): {
    level: number;
    config: EscalationConfig[keyof EscalationConfig];
  } {
    const level = PRIORITY_LEVELS[priority];
    const config = this.escalationConfig[priority];
    return { level, config };
  }

  async getMessageStats(): Promise<{
    total: number;
    sent: number;
    failed: number;
    pending: number;
    todayCount: number;
  }> {
    try {
      const db = this.database.getDb();
      const today = new Date().toISOString().split("T")[0];

      const total = (
        db.prepare("SELECT COUNT(*) as count FROM comms_messages").get() as { count: number }
      ).count;
      const sent = (
        db
          .prepare(
            "SELECT COUNT(*) as count FROM comms_messages WHERE delivery_status = 'sent' OR delivery_status = 'delivered'",
          )
          .get() as { count: number }
      ).count;
      const failed = (
        db
          .prepare("SELECT COUNT(*) as count FROM comms_messages WHERE delivery_status = 'failed'")
          .get() as { count: number }
      ).count;
      const pending = (
        db
          .prepare("SELECT COUNT(*) as count FROM comms_messages WHERE delivery_status = 'pending'")
          .get() as { count: number }
      ).count;
      const todayCount =
        (
          db.prepare("SELECT message_count FROM comms_daily_counts WHERE date = ?").get(today) as
            | { message_count: number }
            | undefined
        )?.message_count ?? 0;

      return { total, sent, failed, pending, todayCount };
    } catch (error) {
      this.api.logger.error("Comms: Failed to get message stats" + String(error));
      return { total: 0, sent: 0, failed: 0, pending: 0, todayCount: this.messageCount };
    }
  }

  private saveMessageToDb(message: CommsMessage): void {
    try {
      const db = this.database.getDb();
      db.prepare(`
        INSERT OR REPLACE INTO comms_messages 
        (id, priority, title, body, timestamp, sent, delivery_status, recipient, error_message, telegram_message_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        message.id,
        message.priority,
        message.title,
        message.body,
        message.timestamp.toISOString(),
        message.sent ? 1 : 0,
        message.deliveryStatus,
        message.recipient || null,
        message.errorMessage || null,
        message.telegramMessageId || null,
      );
    } catch (error) {
      this.api.logger.error("Comms: Failed to save message to DB" + String(error));
    }
  }

  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  async retryFailedMessages(): Promise<{ retried: number; failed: number }> {
    const failedMessages = await this.getMessageHistory(100);
    const toRetry = failedMessages.filter((m) => m.deliveryStatus === "failed");

    let retried = 0;
    let failed = 0;

    for (const message of toRetry) {
      try {
        await this.sendTelegramMessage(message);
        message.deliveryStatus = "sent";
        this.saveMessageToDb(message);
        retried++;
      } catch {
        failed++;
      }
    }

    this.api.logger.info(`Comms: Retry completed - ${retried} retried, ${failed} failed`);
    return { retried, failed };
  }
}
