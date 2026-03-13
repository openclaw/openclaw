export type DiscordUserResolution = {
    input: string;
    resolved: boolean;
    id?: string;
    name?: string;
    guildId?: string;
    guildName?: string;
    note?: string;
};
export declare function resolveDiscordUserAllowlist(params: {
    token: string;
    entries: string[];
    fetcher?: typeof fetch;
}): Promise<DiscordUserResolution[]>;
