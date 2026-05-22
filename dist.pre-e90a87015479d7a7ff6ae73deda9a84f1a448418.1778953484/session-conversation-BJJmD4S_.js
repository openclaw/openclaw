import { t as parseTelegramTopicConversation } from "./topic-conversation-D52Czz_n.js";
//#region extensions/telegram/src/session-conversation.ts
function resolveTelegramSessionConversation(params) {
	const parsed = parseTelegramTopicConversation({ conversationId: params.rawId });
	if (!parsed) return null;
	return {
		id: parsed.chatId,
		threadId: parsed.topicId,
		baseConversationId: parsed.chatId,
		parentConversationCandidates: [parsed.chatId]
	};
}
//#endregion
export { resolveTelegramSessionConversation as t };
