//#region extensions/telegram/src/topic-conversation.ts
function buildTelegramTopicConversationId(params) {
	const chatId = params.chatId.trim();
	const topicId = params.topicId.trim();
	if (!/^-?\d+$/.test(chatId) || !/^\d+$/.test(topicId)) return null;
	return `${chatId}:topic:${topicId}`;
}
function parseTelegramTopicConversation(params) {
	const conversation = params.conversationId.trim();
	const directMatch = conversation.match(/^(-?\d+):topic:(\d+)$/i);
	if (directMatch?.[1] && directMatch[2]) {
		const canonicalConversationId = buildTelegramTopicConversationId({
			chatId: directMatch[1],
			topicId: directMatch[2]
		});
		if (!canonicalConversationId) return null;
		return {
			chatId: directMatch[1],
			topicId: directMatch[2],
			canonicalConversationId
		};
	}
	if (!/^\d+$/.test(conversation)) return null;
	const parent = params.parentConversationId?.trim();
	if (!parent || !/^-?\d+$/.test(parent)) return null;
	const canonicalConversationId = buildTelegramTopicConversationId({
		chatId: parent,
		topicId: conversation
	});
	if (!canonicalConversationId) return null;
	return {
		chatId: parent,
		topicId: conversation,
		canonicalConversationId
	};
}
//#endregion
export { parseTelegramTopicConversation as t };
