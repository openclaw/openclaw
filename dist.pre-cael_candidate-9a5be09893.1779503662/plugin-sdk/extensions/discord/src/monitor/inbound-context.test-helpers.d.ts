export declare function buildFinalizedDiscordDirectInboundContext(): {
    Body: string;
    BodyForAgent: string;
    RawBody: string;
    CommandBody: string;
    From: string;
    To: string;
    SessionKey: string;
    AccountId: string;
    ChatType: string;
    ConversationLabel: string;
    SenderName: string;
    SenderId: string;
    SenderUsername: string;
    GroupSystemPrompt: string | undefined;
    OwnerAllowFrom: string[] | undefined;
    UntrustedStructuredContext: {
        label: string;
        source?: string;
        type?: string;
        payload: unknown;
    }[] | undefined;
    Provider: string;
    Surface: string;
    WasMentioned: boolean;
    MessageSid: string;
    CommandAuthorized: boolean;
    OriginatingChannel: string;
    OriginatingTo: string;
} & Omit<import("openclaw/plugin-sdk/reply-runtime").MsgContext, "CommandAuthorized"> & {
    CommandAuthorized: boolean;
    CommandTurn?: import("openclaw/plugin-sdk/reply-dispatch-runtime").CommandTurnContext;
};
