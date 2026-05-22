export declare function resolveDiscordAttachedOutboundTarget(params: {
    to: string;
    threadId?: string | number | null;
}): string;
export declare function buildDiscordCrossContextPresentation(params: {
    originLabel: string;
    message: string;
}): {
    tone: "neutral";
    blocks: ({
        readonly type: "text";
        readonly text: string;
    } | {
        readonly type: "divider";
        text?: undefined;
    } | {
        type: "context";
        text: string;
    })[];
};
export declare function normalizeDiscordAcpConversationId(conversationId: string): {
    conversationId: string;
} | null;
export declare function matchDiscordAcpConversation(params: {
    bindingConversationId: string;
    conversationId: string;
    parentConversationId?: string;
}): {
    conversationId: string;
    matchPriority: number;
} | null;
export declare function resolveDiscordCommandConversation(params: {
    threadId?: string;
    threadParentId?: string;
    parentSessionKey?: string;
    from?: string;
    chatType?: string;
    originatingTo?: string;
    commandTo?: string;
    fallbackTo?: string;
}): {
    conversationId: string;
    parentConversationId?: string | undefined;
} | null;
export declare function resolveDiscordInboundConversation(params: {
    from?: string;
    to?: string;
    conversationId?: string;
    isGroup: boolean;
}): {
    conversationId: string;
} | null;
export declare function parseDiscordExplicitTarget(raw: string): {
    to: string;
    chatType: "channel" | "direct";
} | null;
