export type ConversationRefShape = {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
};
type ConversationTargetRefShape = {
    conversationId: string;
    parentConversationId?: string | null;
};
export declare function normalizeConversationTargetRef<T extends ConversationTargetRefShape>(ref: T): T;
export declare function normalizeConversationRef<T extends ConversationRefShape>(ref: T): T;
export declare function buildChannelAccountKey(params: {
    channel: string;
    accountId: string;
}): string;
export {};
