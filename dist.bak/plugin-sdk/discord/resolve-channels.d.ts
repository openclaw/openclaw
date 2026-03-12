export type DiscordChannelResolution = {
    input: string;
    resolved: boolean;
    guildId?: string;
    guildName?: string;
    channelId?: string;
    channelName?: string;
    archived?: boolean;
    note?: string;
};
export declare function resolveDiscordChannelAllowlist(params: {
    token: string;
    entries: string[];
    fetcher?: typeof fetch;
}): Promise<DiscordChannelResolution[]>;
