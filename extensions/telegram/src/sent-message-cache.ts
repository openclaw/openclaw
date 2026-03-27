import { resolveGlobalMap } from "../../../src/shared/global-singleton.js";

/**
 * In-memory cache of sent message IDs per chat.
 * Used to identify bot's own messages for reaction filtering ("own" mode).
 */

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

type CacheEntry = {
  timestamps: Map<number, { recordedAt: number; metadata?: SentMessageMetadata }>;
};

export type SentMessageMetadata = {
  sessionKey?: string;
  messageThreadId?: number;
};

/**
 * Keep sent-message tracking shared across bundled chunks so Telegram reaction
 * filters see the same sent-message history regardless of which chunk recorded it.
 */
const TELEGRAM_SENT_MESSAGES_KEY = Symbol.for("openclaw.telegramSentMessages");

const sentMessages = resolveGlobalMap<string, CacheEntry>(TELEGRAM_SENT_MESSAGES_KEY);

function getChatKey(chatId: number | string): string {
  return String(chatId);
}

function normalizeSentMessageMetadata(
  metadata?: SentMessageMetadata,
): SentMessageMetadata | undefined {
  if (!metadata) {
    return undefined;
  }
  const sessionKey = metadata.sessionKey?.trim() || undefined;
  const threadCandidate = metadata.messageThreadId;
  const messageThreadId =
    typeof threadCandidate === "number" && Number.isFinite(threadCandidate) && threadCandidate > 0
      ? Math.trunc(threadCandidate)
      : undefined;
  if (!sessionKey && messageThreadId == null) {
    return undefined;
  }
  return {
    ...(sessionKey ? { sessionKey } : {}),
    ...(messageThreadId != null ? { messageThreadId } : {}),
  };
}

function cleanupExpired(entry: CacheEntry): void {
  const now = Date.now();
  for (const [msgId, record] of entry.timestamps) {
    if (now - record.recordedAt > TTL_MS) {
      entry.timestamps.delete(msgId);
    }
  }
}

/**
 * Record a message ID as sent by the bot.
 */
export function recordSentMessage(
  chatId: number | string,
  messageId: number,
  metadata?: SentMessageMetadata,
): void {
  const key = getChatKey(chatId);
  let entry = sentMessages.get(key);
  if (!entry) {
    entry = { timestamps: new Map() };
    sentMessages.set(key, entry);
  }
  entry.timestamps.set(messageId, {
    recordedAt: Date.now(),
    metadata: normalizeSentMessageMetadata(metadata),
  });
  // Periodic cleanup
  if (entry.timestamps.size > 100) {
    cleanupExpired(entry);
  }
}

/**
 * Check if a message was sent by the bot.
 */
export function wasSentByBot(chatId: number | string, messageId: number): boolean {
  const key = getChatKey(chatId);
  const entry = sentMessages.get(key);
  if (!entry) {
    return false;
  }
  // Clean up expired entries on read
  cleanupExpired(entry);
  return entry.timestamps.has(messageId);
}

/**
 * Recover lightweight routing metadata for a previously sent bot message.
 * Callback payloads for Telegram DM topics can omit thread fields, so we keep
 * enough state here to route follow-up button presses back to the same session.
 */
export function getSentMessageMetadata(
  chatId: number | string,
  messageId: number,
): SentMessageMetadata | undefined {
  const key = getChatKey(chatId);
  const entry = sentMessages.get(key);
  if (!entry) {
    return undefined;
  }
  cleanupExpired(entry);
  return entry.timestamps.get(messageId)?.metadata;
}

/**
 * Clear all cached entries (for testing).
 */
export function clearSentMessageCache(): void {
  sentMessages.clear();
}
