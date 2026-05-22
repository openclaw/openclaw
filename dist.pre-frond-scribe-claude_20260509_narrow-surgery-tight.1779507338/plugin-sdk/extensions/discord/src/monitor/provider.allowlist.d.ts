import type { DiscordAccountConfig, DiscordGuildEntry } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
type GuildEntries = Record<string, DiscordGuildEntry>;
export declare function resolveDiscordAllowlistConfig(params: {
    token: string;
    guildEntries: unknown;
    allowFrom: unknown;
    discordConfig: DiscordAccountConfig;
    fetcher: typeof fetch;
    runtime: RuntimeEnv;
}): Promise<{
    guildEntries: GuildEntries | undefined;
    allowFrom: string[] | undefined;
}>;
export {};
