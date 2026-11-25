import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";

export type TelegramTarget = {
  chatId: string;
  messageThreadId?: number;
  directMessagesTopicId?: number;
  chatType: "direct" | "group" | "unknown";
};

const TELEGRAM_NUMERIC_CHAT_ID_REGEX = /^-?\d+$/;
const TELEGRAM_USERNAME_REGEX = /^[A-Za-z0-9_]{5,}$/i;
const TELEGRAM_TOPIC_SUFFIX_REGEX = /^(.+?):(?:(direct-topic|topic):)?(\d+)$/;

export const TELEGRAM_INVALID_TOPIC_ID_MESSAGE =
  "Telegram topic ID must be a positive safe integer.";

const TELEGRAM_INTERNAL_PREFIXES_RE = /^(?:telegram|tg):(?:\s*(?:telegram|tg|group):)*/i;

export function stripTelegramInternalPrefixes(to: string): string {
  // A Telegram prefix admits the following legacy group and repeated Telegram prefixes.
  return to.trim().replace(TELEGRAM_INTERNAL_PREFIXES_RE, "").trim();
}

export function normalizeTelegramChatId(raw: string): string | undefined {
  const stripped = stripTelegramInternalPrefixes(raw);
  return TELEGRAM_NUMERIC_CHAT_ID_REGEX.test(stripped) ? stripped : undefined;
}

export function isNumericTelegramChatId(raw: string): boolean {
  return TELEGRAM_NUMERIC_CHAT_ID_REGEX.test(raw.trim());
}

export function normalizeTelegramOutboundTarget(raw: string): string {
  const trimmed = raw.trim();
  const legacyGroupMatch = /^group:(-?\d+(?::(?:direct-topic|topic):\d+|:\d+)?)$/i.exec(trimmed);
  return legacyGroupMatch?.[1] ?? raw;
}

export function normalizeTelegramLookupTarget(raw: string): string | undefined {
  const stripped = stripTelegramInternalPrefixes(raw);
  if (TELEGRAM_NUMERIC_CHAT_ID_REGEX.test(stripped)) {
    return stripped;
  }
  const tmeMatch = /^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]+)$/i.exec(stripped);
  if (tmeMatch?.[1]) {
    return `@${tmeMatch[1]}`;
  }
  const handle = stripped.startsWith("@") ? stripped.slice(1) : stripped;
  return TELEGRAM_USERNAME_REGEX.test(handle) ? `@${handle}` : undefined;
}

function resolveTelegramChatType(chatId: string): "direct" | "group" | "unknown" {
  const trimmed = chatId.trim();
  if (TELEGRAM_NUMERIC_CHAT_ID_REGEX.test(trimmed)) {
    return trimmed.startsWith("-") ? "group" : "direct";
  }
  return "unknown";
}

/**
 * Supported delivery targets:
 * - `chatId` (plain chat ID, t.me link, @username, or internal prefixes like `telegram:...`)
 * - `chatId:topicId` (numeric topic/thread ID)
 * - `chatId:topic:topicId` (explicit topic marker; preferred)
 * - `chatId:direct-topic:topicId` (channel Direct Messages topic)
 */
export function parseTelegramTarget(to: string): TelegramTarget {
  const normalized = stripTelegramInternalPrefixes(to);
  const match = TELEGRAM_TOPIC_SUFFIX_REGEX.exec(normalized);
  const chatId = match?.[1];
  const topicIdText = match?.[3];
  if (chatId && topicIdText) {
    const directTopic = match[2] === "direct-topic";
    const topicId = parseStrictPositiveInteger(topicIdText);
    if (topicId !== undefined) {
      return directTopic
        ? { chatId, directMessagesTopicId: topicId, chatType: resolveTelegramChatType(chatId) }
        : { chatId, messageThreadId: topicId, chatType: resolveTelegramChatType(chatId) };
    }
  }
  return {
    chatId: normalized,
    chatType: match ? "unknown" : resolveTelegramChatType(normalized),
  };
}

/**
 * True when a valid chat target carries a topic suffix whose id was rejected.
 * The parser then keeps the whole string as the chat id, so the suffix is still
 * attached to it. A garbage base target keeps the plain invalid-recipient error.
 */
export function hasRejectedTelegramTopic(raw: string): boolean {
  const normalized = stripTelegramInternalPrefixes(raw);
  const base = TELEGRAM_TOPIC_SUFFIX_REGEX.exec(normalized)?.[1];
  return (
    base !== undefined &&
    normalizeTelegramLookupTarget(base) !== undefined &&
    parseTelegramTarget(normalized).chatId === normalized
  );
}

export function resolveTelegramTargetChatType(target: string): "direct" | "group" | "unknown" {
  return parseTelegramTarget(target).chatType;
}
