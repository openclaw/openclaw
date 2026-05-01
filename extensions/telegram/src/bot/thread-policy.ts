import { parseThreadSessionSuffix } from "openclaw/plugin-sdk/routing";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import type { TelegramThreadSpec } from "./helpers.js";

function isStructuredThreadSessionKeyForCandidate(
  sessionKey: string | undefined | null,
  candidateThreadId: string,
): boolean {
  const raw = normalizeOptionalString(sessionKey);
  const normalizedCandidate = normalizeLowercaseStringOrEmpty(candidateThreadId);
  if (!raw || !normalizedCandidate) {
    return false;
  }
  const { baseSessionKey, threadId } = parseThreadSessionSuffix(raw);
  if (!baseSessionKey || !threadId) {
    return false;
  }
  const normalizedBase = normalizeLowercaseStringOrEmpty(baseSessionKey);
  const normalizedThreadId = normalizeLowercaseStringOrEmpty(threadId);
  if (normalizedBase.includes(":thread:") || normalizedThreadId.includes(":thread:")) {
    return false;
  }
  return normalizedThreadId === normalizedCandidate;
}

export function isTrustedTelegramPolicyThreadSessionKey(params: {
  sessionKey: string | undefined | null;
  chatId: string | number | undefined | null;
  thread: TelegramThreadSpec | null | undefined;
}): boolean {
  const threadId = params.thread?.id;
  if (threadId == null) {
    return false;
  }
  const normalizedThreadId = normalizeOptionalString(String(threadId));
  if (!normalizedThreadId) {
    return false;
  }
  const candidateThreadIds = new Set<string>([normalizedThreadId]);
  const normalizedChatId = normalizeOptionalString(
    params.chatId == null ? undefined : String(params.chatId),
  );
  if (normalizedChatId) {
    candidateThreadIds.add(`${normalizedChatId}:${normalizedThreadId}`);
    candidateThreadIds.add(`${normalizedChatId}:topic:${normalizedThreadId}`);
  }
  for (const candidateThreadId of candidateThreadIds) {
    if (isStructuredThreadSessionKeyForCandidate(params.sessionKey, candidateThreadId)) {
      return true;
    }
  }
  return false;
}
