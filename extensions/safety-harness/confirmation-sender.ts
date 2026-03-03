import type { NonceChallenge } from "./nonce.js";

type ChannelType = "discord" | "whatsapp" | "telegram" | "email";

type SendChannelMessageFn = (params: {
  sessionId: string;
  content: string;
  channel?: ChannelType;
}) => Promise<{ ok: boolean }>;

export class ConfirmationSender {
  private sendFn: SendChannelMessageFn;
  private fallbackChain: ChannelType[];

  constructor(
    sendFn: SendChannelMessageFn,
    fallbackChain: ChannelType[] = ["whatsapp", "telegram", "email"],
  ) {
    this.sendFn = sendFn;
    this.fallbackChain = fallbackChain;
  }

  async send(challenge: NonceChallenge, sessionId: string): Promise<boolean> {
    const prompt = challenge.getPrompt();

    try {
      await this.sendFn({ sessionId, content: prompt, channel: "discord" });
      return true;
    } catch {
      for (const channel of this.fallbackChain) {
        try {
          await this.sendFn({ sessionId, content: prompt, channel });
          return true;
        } catch {
          // Continue to next fallback
        }
      }
    }

    return false;
  }
}
