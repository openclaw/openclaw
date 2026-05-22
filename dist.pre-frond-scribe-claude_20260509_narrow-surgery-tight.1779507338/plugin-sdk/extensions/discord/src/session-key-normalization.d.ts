type DiscordSessionKeyContext = {
    ChatType?: string;
    From?: string;
    SenderId?: string;
};
export declare function normalizeExplicitDiscordSessionKey(sessionKey: string, ctx: DiscordSessionKeyContext): string;
export {};
