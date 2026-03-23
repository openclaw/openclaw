import { createScopedExpiringIdCache, resolveGlobalMap } from "openclaw/plugin-sdk/text-runtime";

/**
 * In-memory cache of sent message IDs per chat.
 * Used to identify bot's own messages for reaction filtering ("own" mode).
 */

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Keep sent-message tracking shared across bundled chunks so Telegram reaction
 * filters see the same sent-message history regardless of which chunk recorded it.
 */
const TELEGRAM_SENT_MESSAGES_KEY = Symbol.for("openclaw.telegramSentMessages");

let sentMessages: Map<string, Map<string, number>> | undefined;

function getSentMessages(): Map<string, Map<string, number>> {
  sentMessages ??= resolveGlobalMap<string, Map<string, number>>(TELEGRAM_SENT_MESSAGES_KEY);
  return sentMessages;
}

const sentMessageCache = createScopedExpiringIdCache<number | string, number>({
  store: getSentMessages(),
  ttlMs: TTL_MS,
  cleanupThreshold: 100,
});

/**
 * Record a message ID as sent by the bot.
 */
export function recordSentMessage(chatId: number | string, messageId: number): void {
  sentMessageCache.record(chatId, messageId);
}

/**
 * Check if a message was sent by the bot.
 */
export function wasSentByBot(chatId: number | string, messageId: number): boolean {
  return sentMessageCache.has(chatId, messageId);
}

/**
 * Clear all cached entries (for testing).
 */
export function clearSentMessageCache(): void {
  sentMessageCache.clear();
}
