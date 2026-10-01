import { parseStrictInteger } from "openclaw/plugin-sdk/number-runtime";

export {
  parseStrictInteger as normalizeTelegramReplyToMessageId,
  parseStrictNonNegativeInteger as parseTelegramMessageThreadId,
} from "openclaw/plugin-sdk/number-runtime";

export function parseTelegramReplyToMessageId(replyToId?: unknown): number | undefined {
  return parseStrictInteger(replyToId);
}

export function parseTelegramThreadId(threadId?: string | number | null): number | undefined {
  if (threadId == null) {
    return undefined;
  }
  if (typeof threadId === "number") {
    return parseStrictInteger(threadId);
  }
  const trimmed = threadId.trim();
  if (!trimmed) {
    return undefined;
  }
  const topicMatch = /^-?\d+:topic:(\d+)$/.exec(trimmed);
  if (topicMatch) {
    return parseStrictInteger(topicMatch[1]);
  }
  // DM topic session keys may scope thread ids as "<chatId>:<threadId>".
  const scopedMatch = /^-?\d+:(-?\d+)$/.exec(trimmed);
  const rawThreadId = scopedMatch ? scopedMatch[1] : trimmed;
  return parseStrictInteger(rawThreadId);
}
