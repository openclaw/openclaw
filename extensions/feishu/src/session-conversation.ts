import { buildFeishuConversationId, parseFeishuConversationId } from "./conversation-id.js";

function resolveFeishuParentConversationCandidates(rawId: string): string[] {
  const parsed = parseFeishuConversationId({ conversationId: rawId });
  if (!parsed) {
    return [];
  }
  switch (parsed.scope) {
    case "group_topic_sender":
      return [
        buildFeishuConversationId({
          chatId: parsed.chatId,
          scope: "group_topic",
          topicId: parsed.topicId,
        }),
        parsed.chatId,
      ];
    case "group_topic":
    case "group_sender":
      return [parsed.chatId];
    default:
      return [];
  }
}

export function resolveFeishuSessionConversation(params: {
  kind: "group" | "channel";
  rawId: string;
}) {
  const parsed = parseFeishuConversationId({ conversationId: params.rawId });
  if (!parsed) {
    return null;
  }
  // Core derives outbound delivery from the session key and asks for the thread id here.
  // Without it a topic session's proactive sends (heartbeat, scheduled work) lose their topic
  // and post a new top-level message, which starts a new topic in a Feishu topic chat.
  const topicScoped = parsed.scope === "group_topic" || parsed.scope === "group_topic_sender";
  return {
    id: parsed.canonicalConversationId,
    threadId: topicScoped ? parsed.topicId : undefined,
    baseConversationId: parsed.chatId,
    parentConversationCandidates: resolveFeishuParentConversationCandidates(
      parsed.canonicalConversationId,
    ),
  };
}
