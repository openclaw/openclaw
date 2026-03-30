export type ParsedTelegramTopicConversation = {
	chatId: string;
	topicId: string;
	canonicalConversationId: string;
};

export function normalizeConversationText(value: unknown): string {
	if (typeof value === "string") {
		return value.trim();
	}
	if (
		typeof value === "number" ||
		typeof value === "bigint" ||
		typeof value === "boolean"
	) {
		return `${value}`.trim();
	}
	return "";
}

export function parseTelegramChatIdFromTarget(
	raw: unknown,
): string | undefined {
	const text = normalizeConversationText(raw);
	if (!text) {
		return undefined;
	}
	const match = text.match(/^telegram:(-?\d+)$/);
	if (!match?.[1]) {
		return undefined;
	}
	return match[1];
}

export function buildTelegramTopicConversationId(params: {
	chatId: string;
	topicId: string;
}): string | null {
	const chatId = params.chatId.trim();
	const topicId = params.topicId.trim();
	if (!/^-?\d+$/.test(chatId) || !/^\d+$/.test(topicId)) {
		return null;
	}
	return `${chatId}:topic:${topicId}`;
}

export function parseTelegramTopicConversation(params: {
	conversationId: string;
	parentConversationId?: string;
}): ParsedTelegramTopicConversation | null {
	const conversation = params.conversationId.trim();
	const directMatch = conversation.match(/^(-?\d+):topic:(\d+)$/);
	if (directMatch?.[1] && directMatch[2]) {
		const canonicalConversationId = buildTelegramTopicConversationId({
			chatId: directMatch[1],
			topicId: directMatch[2],
		});
		if (!canonicalConversationId) {
			return null;
		}
		return {
			chatId: directMatch[1],
			topicId: directMatch[2],
			canonicalConversationId,
		};
	}
	if (!/^\d+$/.test(conversation)) {
		return null;
	}
	const parent = params.parentConversationId?.trim();
	if (!parent || !/^-?\d+$/.test(parent)) {
		return null;
	}
	const canonicalConversationId = buildTelegramTopicConversationId({
		chatId: parent,
		topicId: conversation,
	});
	if (!canonicalConversationId) {
		return null;
	}
	return {
		chatId: parent,
		topicId: conversation,
		canonicalConversationId,
	};
}
