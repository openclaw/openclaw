export type DiscordGuildSummary = {
    id: string;
    name: string;
    slug: string;
};
export declare function listGuilds(token: string, fetcher: typeof fetch): Promise<DiscordGuildSummary[]>;
