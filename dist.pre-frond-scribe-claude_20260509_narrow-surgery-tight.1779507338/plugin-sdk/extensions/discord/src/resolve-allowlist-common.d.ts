import type { DiscordGuildSummary } from "./guilds.js";
export declare function resolveDiscordAllowlistToken(token: string): string | undefined;
export declare function buildDiscordUnresolvedResults<T extends {
    input: string;
    resolved: boolean;
}>(entries: string[], buildResult: (input: string) => T): T[];
export declare function findDiscordGuildByName(guilds: DiscordGuildSummary[], input: string): DiscordGuildSummary | undefined;
export declare function filterDiscordGuilds(guilds: DiscordGuildSummary[], params: {
    guildId?: string;
    guildName?: string;
}): DiscordGuildSummary[];
