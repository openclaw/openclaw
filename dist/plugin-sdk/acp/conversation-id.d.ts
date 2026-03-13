export type ParsedTelegramTopicConversation = {
    chatId: string;
    topicId: string;
    canonicalConversationId: string;
};
export declare function parseTelegramChatIdFromTarget(raw: unknown): string | undefined;
export declare function buildTelegramTopicConversationId(params: {
    chatId: string;
    topicId: string;
}): string | null;
export declare function parseTelegramTopicConversation(params: {
    conversationId: string;
    parentConversationId?: string;
}): ParsedTelegramTopicConversation | null;
