import { parseTelegramTopicConversation } from "openclaw/plugin-sdk/telegram-core";

export function resolveTelegramSessionConversation(params: {
  kind: "group" | "channel";
  rawId: string;
}) {
  const parsed = parseTelegramTopicConversation({ conversationId: params.rawId });
  if (!parsed) {
    return null;
  }
  return {
    id: parsed.chatId,
    threadId: parsed.topicId,
    parentConversationCandidates: [parsed.chatId],
  };
}
