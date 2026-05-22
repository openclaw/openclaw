export declare function resolveDiscordConversationIdentity(params: {
    isDirectMessage: boolean;
    userId?: string | null;
    channelId?: string | null;
}): string | undefined;
export declare function resolveDiscordCurrentConversationIdentity(params: {
    chatType?: string | null;
    from?: string | null;
    originatingTo?: string | null;
    commandTo?: string | null;
    fallbackTo?: string | null;
}): string | undefined;
