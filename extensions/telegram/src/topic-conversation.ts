import {
  normalizeTelegramLookupTarget,
  parseTelegramTarget,
  type TelegramTarget,
} from "./targets.js";
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
  let chatId = normalizeTelegramLookupTarget(target.chatId);
  let thread: TelegramThreadSpec | null =
    target.directMessagesTopicId != null
      ? { id: target.directMessagesTopicId, scope: "direct-messages" }
      : target.messageThreadId == null
        ? null
        : { id: target.messageThreadId, scope: "forum" };
  if (!chatId || !thread) {
    const parent = params.parentConversationId?.trim();
    if (!/^\d+$/.test(conversationId) || !parent || parent === conversationId) {
      return null;
    }
    chatId = parent;
    thread = { id: Number(conversationId), scope: "forum" };
  }
  const canonicalConversationId = serializeTelegramTopicConversation({ chatId, thread });
  return canonicalConversationId ? { chatId, thread, canonicalConversationId } : null;
}

/** Thread spec carried by a parsed target; an encoded topic wins over the fallback. */
export function resolveTelegramTargetThread(
  target: Pick<TelegramTarget, "messageThreadId" | "directMessagesTopicId">,
  fallbackThreadId?: string | number | null,
): TelegramThreadSpec {
  if (target.directMessagesTopicId != null) {
    return { id: target.directMessagesTopicId, scope: "direct-messages" };
  }
  const forumThreadId = target.messageThreadId ?? fallbackThreadId;
  if (forumThreadId == null) {
    return { scope: "none" };
  }
  const id = Number(forumThreadId);
  return Number.isFinite(id) ? { id, scope: "forum" } : { scope: "none" };
}

/**
 * The one Telegram conversation identity: a topic conversation id, else a
 * target whose encoded topic wins over the separate thread id.
 */
export function resolveTelegramConversationRef(params: {
  to?: string;
  conversationId?: string;
  parentConversationId?: string;
  threadId?: string | number | null;
}): { chatId: string; thread: TelegramThreadSpec; conversationId: string } | null {
  const topic =
    params.conversationId &&
    parseTelegramTopicConversation({
      conversationId: params.conversationId,
      parentConversationId: params.parentConversationId,
    });
  if (topic) {
    return {
      chatId: topic.chatId,
      thread: topic.thread,
      conversationId: topic.canonicalConversationId,
    };
  }
  const target = parseTelegramTarget(
    params.to || params.parentConversationId || params.conversationId || "",
  );
  const chatId = target.chatId.trim();
  if (!chatId) {
    return null;
  }
  const thread = resolveTelegramTargetThread(target, params.threadId);
  return { chatId, thread, conversationId: buildTelegramConversationId({ chatId, thread }) };
}
