import { parseStrictInteger } from "openclaw/plugin-sdk/number-runtime";

export {
  parseStrictInteger as normalizeTelegramReplyToMessageId,
  parseStrictNonNegativeInteger as parseTelegramMessageThreadId,
} from "openclaw/plugin-sdk/number-runtime";

export function parseTelegramReplyToMessageId(replyToId?: unknown): number | undefined {
  return parseStrictInteger(replyToId);
}

export function parseTelegramThreadId(threadId?: string | number | null): number | undefined {
  if (typeof threadId !== "string") {
    return parseStrictInteger(threadId);
  }
  const trimmed = threadId.trim();
  // Forum topics require a nonnegative ID; DM topic session keys also carry signed IDs.
  const scopedMatch = /^-?\d+:(?:topic:(\d+)|(-?\d+))$/.exec(trimmed);
  return parseStrictInteger(scopedMatch?.[1] ?? scopedMatch?.[2] ?? trimmed);
}
