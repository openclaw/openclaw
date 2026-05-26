type ThreadBindingPlacement = "current" | "child";
type ThreadBindingInboundConversationParams = {
    from?: string;
    to?: string;
    conversationId?: string;
    threadId?: string | number;
    isGroup: boolean;
};
type ThreadBindingConversationRef = {
    conversationId?: string;
    parentConversationId?: string;
};
export declare function resolveBundledChannelThreadBindingDefaultPlacement(channelId: string): ThreadBindingPlacement | undefined;
export declare function resolveBundledChannelThreadBindingInboundConversation(params: ThreadBindingInboundConversationParams & {
    channelId: string;
}): ThreadBindingConversationRef | null | undefined;
export {};
