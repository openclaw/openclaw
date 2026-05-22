import { n as normalizeTelegramChatId, r as normalizeTelegramLookupTarget } from "./targets-DFk7ZTwb.js";
import { t as parseTelegramTopicConversation } from "./topic-conversation-Ht2aXTQw.js";
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
function resolveTelegramSessionTarget(params) {
	const raw = params.kind === "group" ? `telegram:group:${params.id}` : `telegram:${params.id}`;
	return normalizeTelegramChatId(raw) ?? normalizeTelegramLookupTarget(raw);
}
//#endregion
export { resolveTelegramSessionTarget as n, resolveTelegramSessionConversation as t };
