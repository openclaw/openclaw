import { getWechatRuntime } from "./runtime.js";

/**
 * Active Wechaty bot instances keyed by account ID.
 * Set by the monitor when the bot logs in.
 */
const activeBots = new Map<string, unknown>();

/** Register an active Wechaty bot instance. */
export function registerWechatBot(accountId: string, bot: unknown): void {
  activeBots.set(accountId, bot);
}

/** Unregister a Wechaty bot instance. */
export function unregisterWechatBot(accountId: string): void {
  activeBots.delete(accountId);
}

/** Get the active bot for an account. */
export function getWechatBot(accountId: string): unknown | undefined {
  return activeBots.get(accountId);
}

/**
 * Send a text message via Wechaty.
 * The bot instance is dynamically imported to avoid hard ESM dep on wechaty at load time.
 */
export async function sendMessageWechat(
  to: string,
  text: string,
  opts?: { accountId?: string; isRoom?: boolean },
): Promise<{ messageId: string; target: string }> {
  const runtime = getWechatRuntime();
  const accountId = opts?.accountId ?? "default";
  const bot = activeBots.get(accountId);

  if (!bot) {
    throw new Error(`WeChat bot not running for account "${accountId}"`);
  }

  // Duck-type the bot to avoid hard dependency on wechaty types at compile time
  const wechatyBot = bot as {
    Room: {
      find: (query: { id: string }) => Promise<{ say: (text: string) => Promise<void> } | null>;
    };
    Contact: {
      find: (query: { id: string }) => Promise<{ say: (text: string) => Promise<void> } | null>;
    };
  };

  if (opts?.isRoom) {
    const room = await wechatyBot.Room.find({ id: to });
    if (!room) {
      throw new Error(`WeChat room not found: ${to}`);
    }
    await room.say(text);
  } else {
    const contact = await wechatyBot.Contact.find({ id: to });
    if (!contact) {
      throw new Error(`WeChat contact not found: ${to}`);
    }
    await contact.say(text);
  }

  runtime.channel.activity.record({
    channel: "wechat",
    accountId,
    direction: "outbound",
  });

  return { messageId: `wechat_${Date.now()}`, target: to };
}
