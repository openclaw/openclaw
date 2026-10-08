import { normalizeTelegramLookupTarget, parseTelegramTarget } from "./targets.js";
import type { TelegramThreadSpec } from "./thread-spec.js";

export type ParsedTelegramTopicConversation = {
  chatId: string;
  thread: TelegramThreadSpec;
  canonicalConversationId: string;
};

function serializeTelegramTopicConversation(params: {
  chatId: string;
  thread: TelegramThreadSpec;
}): string | null {
  const chatId = normalizeTelegramLookupTarget(params.chatId);
  const id = params.thread.id == null ? undefined : Math.trunc(params.thread.id);
  if (!chatId || id == null || !Number.isFinite(id)) {
    return null;
  }
  const marker =
    params.thread.scope === "direct-messages" && id > 0
      ? "direct-topic"
      : (params.thread.scope === "forum" || params.thread.scope === "dm") && id >= 0
        ? "topic"
        : null;
  return marker ? `${chatId}:${marker}:${id}` : null;
}

export function buildTelegramConversationId(params: {
  chatId: string | number;
  thread: TelegramThreadSpec;
}): string {
  const chatId = String(params.chatId).trim();
  return serializeTelegramTopicConversation({ chatId, thread: params.thread }) ?? chatId;
}

export function parseTelegramTopicConversation(params: {
  conversationId: string;
  parentConversationId?: string;
}): ParsedTelegramTopicConversation | null {
  const conversationId = params.conversationId
    .trim()
    .replace(/:(direct-topic|topic):/i, (_match, marker: string) => `:${marker.toLowerCase()}:`);
  const target = parseTelegramTarget(conversationId);
  const chatId = normalizeTelegramLookupTarget(target.chatId);
  const thread: TelegramThreadSpec | null =
    target.directMessagesTopicId != null
      ? { id: target.directMessagesTopicId, scope: "direct-messages" }
      : target.messageThreadId == null
        ? null
        : { id: target.messageThreadId, scope: "forum" };
  if (chatId && thread) {
    const canonicalConversationId = serializeTelegramTopicConversation({ chatId, thread });
    return canonicalConversationId ? { chatId, thread, canonicalConversationId } : null;
  }
  const parent = params.parentConversationId?.trim();
  if (!/^\d+$/.test(conversationId) || !parent || parent === conversationId) {
    return null;
  }
  const parentThread: TelegramThreadSpec = { id: Number(conversationId), scope: "forum" };
  const canonicalConversationId = serializeTelegramTopicConversation({
    chatId: parent,
    thread: parentThread,
  });
  return canonicalConversationId
    ? { chatId: parent, thread: parentThread, canonicalConversationId }
    : null;
}
