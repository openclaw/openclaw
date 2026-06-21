// Telegram plugin module owns canonical conversation identity resolution.
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parseTelegramTarget } from "./targets.js";

export function resolveTelegramCommandConversation(params: {
  threadId?: string | number;
  originatingTo?: string;
  commandTo?: string;
  fallbackTo?: string;
}) {
  const chatId = [params.originatingTo, params.commandTo, params.fallbackTo]
    .map((candidate) => {
      const trimmed = normalizeOptionalString(candidate) ?? "";
      return trimmed ? (normalizeOptionalString(parseTelegramTarget(trimmed).chatId) ?? "") : "";
    })
    .find((candidate) => candidate.length > 0);
  if (!chatId) {
    return null;
  }
  const threadId =
    params.threadId == null ? undefined : normalizeOptionalString(String(params.threadId));
  if (threadId) {
    return {
      conversationId: `${chatId}:topic:${threadId}`,
      parentConversationId: chatId,
    };
  }
  if (chatId.startsWith("-")) {
    return null;
  }
  return {
    conversationId: chatId,
    parentConversationId: chatId,
  };
}
