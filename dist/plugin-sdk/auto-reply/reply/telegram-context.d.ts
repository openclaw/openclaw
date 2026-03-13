type TelegramConversationParams = {
    ctx: {
        MessageThreadId?: string | number | null;
        OriginatingTo?: string;
        To?: string;
    };
    command: {
        to?: string;
    };
};
export declare function resolveTelegramConversationId(params: TelegramConversationParams): string | undefined;
export {};
