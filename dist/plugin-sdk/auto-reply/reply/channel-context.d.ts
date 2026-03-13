type DiscordSurfaceParams = {
    ctx: {
        OriginatingChannel?: string;
        Surface?: string;
        Provider?: string;
        AccountId?: string;
    };
    command: {
        channel?: string;
    };
};
type DiscordAccountParams = {
    ctx: {
        AccountId?: string;
    };
};
export declare function isDiscordSurface(params: DiscordSurfaceParams): boolean;
export declare function isTelegramSurface(params: DiscordSurfaceParams): boolean;
export declare function resolveCommandSurfaceChannel(params: DiscordSurfaceParams): string;
export declare function resolveDiscordAccountId(params: DiscordAccountParams): string;
export declare function resolveChannelAccountId(params: DiscordAccountParams): string;
export {};
