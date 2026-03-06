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
export declare function resolveDiscordAccountId(params: DiscordAccountParams): string;
export {};
