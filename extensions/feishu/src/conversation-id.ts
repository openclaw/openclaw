export type FeishuGroupSessionScope =
  | "group"
  | "group_sender"
  | "group_topic"
  | "group_topic_sender";

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function buildFeishuConversationId(params: {
  chatId: string;
  scope: FeishuGroupSessionScope;
  senderOpenId?: string;
  topicId?: string;
}): string {
  const chatId = normalizeText(params.chatId) ?? "unknown";
  const senderOpenId = normalizeText(params.senderOpenId);
  const topicId = normalizeText(params.topicId);

  switch (params.scope) {
    case "group_sender":
      return senderOpenId ? `${chatId}:sender:${senderOpenId}` : chatId;
    case "group_topic":
      return topicId ? `${chatId}:topic:${topicId}` : chatId;
    case "group_topic_sender":
      if (topicId && senderOpenId) {
        return `${chatId}:topic:${topicId}:sender:${senderOpenId}`;
      }
      if (topicId) {
        return `${chatId}:topic:${topicId}`;
      }
      return senderOpenId ? `${chatId}:sender:${senderOpenId}` : chatId;
    case "group":
    default:
      return chatId;
  }
}

export function parseFeishuConversationId(params: {
  conversationId: string;
  parentConversationId?: string;
}): {
  canonicalConversationId: string;
  chatId: string;
  topicId?: string;
  senderOpenId?: string;
  scope: FeishuGroupSessionScope;
} | null {
  const conversationId = normalizeText(params.conversationId);
  const parentConversationId = normalizeText(params.parentConversationId);
  if (!conversationId) {
    return null;
  }

  const topicSenderMatch = conversationId.match(/^(.+):topic:([^:]+):sender:([^:]+)$/);
  if (topicSenderMatch) {
    const [, chatId, topicId, senderOpenId] = topicSenderMatch;
    return {
      canonicalConversationId: buildFeishuConversationId({
        chatId,
        scope: "group_topic_sender",
        topicId,
        senderOpenId,
      }),
      chatId,
      topicId,
      senderOpenId,
      scope: "group_topic_sender",
    };
  }

  const topicMatch = conversationId.match(/^(.+):topic:([^:]+)$/);
  if (topicMatch) {
    const [, chatId, topicId] = topicMatch;
    return {
      canonicalConversationId: buildFeishuConversationId({
        chatId,
        scope: "group_topic",
        topicId,
      }),
      chatId,
      topicId,
      scope: "group_topic",
    };
  }

  const senderMatch = conversationId.match(/^(.+):sender:([^:]+)$/);
  if (senderMatch) {
    const [, chatId, senderOpenId] = senderMatch;
    return {
      canonicalConversationId: buildFeishuConversationId({
        chatId,
        scope: "group_sender",
        senderOpenId,
      }),
      chatId,
      senderOpenId,
      scope: "group_sender",
    };
  }

  if (parentConversationId) {
    return {
      canonicalConversationId: buildFeishuConversationId({
        chatId: parentConversationId,
        scope: "group_topic",
        topicId: conversationId,
      }),
      chatId: parentConversationId,
      topicId: conversationId,
      scope: "group_topic",
    };
  }

  return {
    canonicalConversationId: conversationId,
    chatId: conversationId,
    scope: "group",
  };
}
