import { parseTelegramTarget } from "./targets.js";
import { parseTelegramTopicConversation } from "./topic-conversation.js";

export function normalizeTelegramAcpConversationId(conversationId: string) {
  const parsed = parseTelegramTopicConversation({ conversationId });
  if (!parsed || !parsed.chatId.startsWith("-")) {
    return null;
  }
  return {
    conversationId: parsed.canonicalConversationId,
    parentConversationId: parsed.chatId,
  };
}

export function matchTelegramAcpConversation(params: {
  bindingConversationId: string;
  conversationId: string;
  parentConversationId?: string;
}) {
  const binding = normalizeTelegramAcpConversationId(params.bindingConversationId);
  if (!binding) {
    return null;
  }
  const incoming = parseTelegramTopicConversation({
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
  });
  if (!incoming || !incoming.chatId.startsWith("-")) {
    return null;
  }
  if (binding.conversationId !== incoming.canonicalConversationId) {
    return null;
  }
  return {
    conversationId: incoming.canonicalConversationId,
    parentConversationId: incoming.chatId,
    matchPriority: 2,
  };
}

export function resolveTelegramCommandConversation(params: {
  threadId?: string;
  originatingTo?: string;
  commandTo?: string;
  fallbackTo?: string;
}) {
  const chatId = [params.originatingTo, params.commandTo, params.fallbackTo]
    .map((candidate) => {
      const trimmed = candidate?.trim();
      return trimmed ? parseTelegramTarget(trimmed).chatId.trim() : "";
    })
    .find((candidate) => candidate.length > 0);
  if (!chatId) {
    return null;
  }
  if (params.threadId) {
    return {
      conversationId: `${chatId}:topic:${params.threadId}`,
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
