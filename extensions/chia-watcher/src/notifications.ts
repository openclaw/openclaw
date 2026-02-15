import type { CoinEvent } from "./types";

export class NotificationEngine {
  private api: any;
  private channel: string | undefined;
  private to: string | undefined;
  private logger: any;

  constructor(opts: { api: any; channel?: string; to?: string; logger?: any }) {
    this.api = opts.api;
    this.channel = opts.channel;
    this.to = opts.to;
    this.logger = opts.logger ?? console;
  }

  async send(message: string): Promise<boolean> {
    try {
      const to = this.to;
      const channel = this.channel;
      
      if (!to) {
        this.logger.warn(`[chia-watcher] No notification target configured`);
        this.logger.info(`[chia-watcher] NOTIFICATION: ${message}`);
        return false;
      }

      // Extract the raw chat ID from "telegram:123456" format
      const chatId = to.includes(":") ? to.split(":").slice(1).join(":") : to;

      // Use OpenClaw runtime channel APIs for direct delivery
      if (channel === "telegram" && this.api.runtime?.channel?.telegram?.sendMessageTelegram) {
        await this.api.runtime.channel.telegram.sendMessageTelegram(chatId, message);
        return true;
      }

      if (channel === "signal" && this.api.runtime?.channel?.signal?.sendMessageSignal) {
        await this.api.runtime.channel.signal.sendMessageSignal(chatId, message);
        return true;
      }

      if (channel === "discord" && this.api.runtime?.channel?.discord?.sendMessageDiscord) {
        await this.api.runtime.channel.discord.sendMessageDiscord(chatId, message);
        return true;
      }

      if (channel === "whatsapp" && this.api.runtime?.channel?.whatsapp?.sendMessageWhatsApp) {
        await this.api.runtime.channel.whatsapp.sendMessageWhatsApp(chatId, message);
        return true;
      }

      // Fallback: inject as system event into main session
      if (this.api.runtime?.system?.enqueueSystemEvent) {
        this.api.runtime.system.enqueueSystemEvent(message, { sessionKey: "agent:main:main" });
        this.logger.info(`[chia-watcher] Notification injected as system event`);
        return true;
      }

      this.logger.warn(`[chia-watcher] No delivery method available, logging only`);
      this.logger.info(`[chia-watcher] NOTIFICATION: ${message}`);
      return false;
    } catch (err: any) {
      this.logger.error(`[chia-watcher] Failed to send notification: ${err.message}`);
      return false;
    }
  }

  async sendCoinAlert(event: CoinEvent, formattedMessage: string): Promise<boolean> {
    const prefix = event.isCat ? "🪙" : "💰";
    const fullMessage = `${prefix} **Chia Watcher Alert**\n\n${formattedMessage}`;
    return this.send(fullMessage);
  }

  updateConfig(channel?: string, to?: string) {
    this.channel = channel;
    this.to = to;
  }
}
