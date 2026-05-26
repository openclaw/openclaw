import { r as parseFeishuConversationId, t as buildFeishuConversationId } from "./conversation-id-Cp5_uafu.js";
//#region extensions/feishu/src/session-conversation.ts
function resolveFeishuParentConversationCandidates(rawId) {
	const parsed = parseFeishuConversationId({ conversationId: rawId });
	if (!parsed) return [];
	switch (parsed.scope) {
		case "group_topic_sender": return [buildFeishuConversationId({
			chatId: parsed.chatId,
			scope: "group_topic",
			topicId: parsed.topicId
		}), parsed.chatId];
		case "group_topic":
		case "group_sender": return [parsed.chatId];
		default: return [];
	}
}
function resolveFeishuSessionConversation(params) {
	const parsed = parseFeishuConversationId({ conversationId: params.rawId });
	if (!parsed) return null;
	return {
		id: parsed.canonicalConversationId,
		baseConversationId: parsed.chatId,
		parentConversationCandidates: resolveFeishuParentConversationCandidates(parsed.canonicalConversationId)
	};
}
//#endregion
export { resolveFeishuSessionConversation as t };
