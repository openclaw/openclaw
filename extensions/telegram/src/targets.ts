// Telegram plugin module implements targets behavior.
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";

export type TelegramTarget = {
  chatId: string;
  messageThreadId?: number;
  chatType: "direct" | "group" | "unknown";
};

const TELEGRAM_NUMERIC_CHAT_ID_REGEX = /^-?\d+$/;
const TELEGRAM_USERNAME_REGEX = /^[A-Za-z0-9_]{5,}$/i;

export function stripTelegramInternalPrefixes(to: string): string {
  let trimmed = to.trim();
  let strippedTelegramPrefix = false;
  while (true) {
    const next = (() => {
      if (/^(telegram|tg):/i.test(trimmed)) {
        strippedTelegramPrefix = true;
        return trimmed.replace(/^(telegram|tg):/i, "").trim();
      }
      // Legacy internal form: `telegram:group:<id>` (still emitted by session keys).
      if (strippedTelegramPrefix && /^group:/i.test(trimmed)) {
        return trimmed.replace(/^group:/i, "").trim();
      }
      return trimmed;
    })();
    if (next === trimmed) {
      return trimmed;
    }
    trimmed = next;
  }
}

export function normalizeTelegramChatId(raw: string): string | undefined {
  const stripped = stripTelegramInternalPrefixes(raw);
  if (!stripped) {
    return undefined;
  }
  if (TELEGRAM_NUMERIC_CHAT_ID_REGEX.test(stripped)) {
    return stripped;
  }
  return undefined;
}

export function isNumericTelegramChatId(raw: string): boolean {
  return TELEGRAM_NUMERIC_CHAT_ID_REGEX.test(raw.trim());
}

export function normalizeTelegramOutboundTarget(raw: string): string {
  const trimmed = raw.trim();
  const legacyGroupMatch = /^group:(-?\d+(?::topic:\d+|:\d+)?)$/i.exec(trimmed);
  if (legacyGroupMatch?.[1]) {
    return legacyGroupMatch[1];
  }
  return raw;
}

export function normalizeTelegramLookupTarget(raw: string): string | undefined {
  const stripped = stripTelegramInternalPrefixes(raw);
  if (!stripped) {
    return undefined;
  }
  if (isNumericTelegramChatId(stripped)) {
    return stripped;
  }
  const tmeMatch = /^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]+)$/i.exec(stripped);
  if (tmeMatch?.[1]) {
    return `@${tmeMatch[1]}`;
  }
  if (stripped.startsWith("@")) {
    const handle = stripped.slice(1);
    if (!handle || !TELEGRAM_USERNAME_REGEX.test(handle)) {
      return undefined;
    }
    return `@${handle}`;
  }
  if (TELEGRAM_USERNAME_REGEX.test(stripped)) {
    return `@${stripped}`;
  }
  return undefined;
}

/**
 * Parse a Telegram delivery target into chatId and optional topic/thread ID.
 *
 * Supported formats:
 * - `chatId` (plain chat ID, t.me link, @username, or internal prefixes like `telegram:...`)
 * - `chatId:topicId` (numeric topic/thread ID)
 * - `chatId:topic:topicId` (explicit topic marker; preferred)
 */
function resolveTelegramChatType(chatId: string): "direct" | "group" | "unknown" {
  const trimmed = chatId.trim();
  if (!trimmed) {
    return "unknown";
  }
  if (isNumericTelegramChatId(trimmed)) {
    return trimmed.startsWith("-") ? "group" : "direct";
  }
  return "unknown";
}

// When a chatId extracted by one of the thread-suffix parsers contains
// unexpected colons that are not part of a known t.me URL form, the parser
// is oversplitting — fall back to full-string instead of silently
// embedding colon-separated residue in chatId.
const LOOKS_LIKE_TME_URL = /^(?:https?:\/\/)?t\.me\//i;

function hasOversplitColons(chatId: string): boolean {
  return chatId.includes(":") && !LOOKS_LIKE_TME_URL.test(chatId);
}

export function parseTelegramTarget(to: string): TelegramTarget {
  const normalized = stripTelegramInternalPrefixes(to);

  // Non-greedy (.+?) stops at the first :topic:, which correctly handles
  // URL forms like "t.me/mychannel:topic:9". The guard rejects chatIds
  // with unexpected colons (e.g. "a:b:topic:42" → "a:b" is not a real chatId).
  const topicMatch = /^(.+?):topic:(\d+)$/.exec(normalized);
  if (topicMatch) {
    if (hasOversplitColons(topicMatch[1])) {
      return {
        chatId: normalized,
        chatType: resolveTelegramChatType(normalized),
      };
    }
    const messageThreadId = parseStrictNonNegativeInteger(topicMatch[2]);
    if (messageThreadId === undefined) {
      return {
        chatId: normalized,
        chatType: resolveTelegramChatType(normalized),
      };
    }
    return {
      chatId,
      messageThreadId,
      chatType: resolveTelegramChatType(chatId),
    };
  }

  // Greedy (.+) so URL-form targets like "https://t.me/mychannel:9" still
  // parse (the scheme colon is not a thread-spec delimiter). Guard rejects
  // chatIds with unexpected colons, same invariant as the topic parser.
  const colonMatch = /^(.+):(\d+)$/.exec(normalized);
  if (colonMatch) {
    if (hasOversplitColons(colonMatch[1])) {
      return {
        chatId: normalized,
        chatType: resolveTelegramChatType(normalized),
      };
    }
    const messageThreadId = parseStrictNonNegativeInteger(colonMatch[2]);
    if (messageThreadId === undefined) {
      return {
        chatId: normalized,
        chatType: resolveTelegramChatType(normalized),
      };
    }
    return {
      chatId,
      messageThreadId,
      chatType: resolveTelegramChatType(chatId),
    };
  }

  return {
    chatId: normalized,
    chatType: resolveTelegramChatType(normalized),
  };
}

export function resolveTelegramTargetChatType(target: string): "direct" | "group" | "unknown" {
  return parseTelegramTarget(target).chatType;
}
