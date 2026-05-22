import type { DiscordGuildEntry, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
type DiscordChannelPermissionsAuditEntry = {
    channelId: string;
    ok: boolean;
    missing?: string[];
    error?: string | null;
    matchKey?: string;
    matchSource?: "id";
};
export type DiscordChannelPermissionsAudit = {
    ok: boolean;
    checkedChannels: number;
    unresolvedChannels: number;
    channels: DiscordChannelPermissionsAuditEntry[];
    elapsedMs: number;
};
export declare function resolveRequiredDiscordChannelPermissions(channelType?: number): string[];
export declare function collectDiscordAuditChannelIdsForGuilds(guilds: Record<string, DiscordGuildEntry> | undefined): {
    channelIds: string[];
    unresolvedChannels: number;
};
export declare function collectDiscordAuditChannelIdsForAccount(config: {
    guilds?: Record<string, DiscordGuildEntry>;
    voice?: {
        autoJoin?: Array<{
            guildId?: string;
            channelId?: string;
        }>;
    };
}): {
    channelIds: string[];
    unresolvedChannels: number;
};
export declare function auditDiscordChannelPermissionsWithFetcher(params: {
    cfg: OpenClawConfig;
    token: string;
    accountId?: string | null;
    channelIds: string[];
    timeoutMs: number;
    fetchChannelPermissions: (channelId: string, params: {
        cfg: OpenClawConfig;
        token: string;
        accountId?: string;
    }) => Promise<{
        permissions: string[];
        channelType?: number;
    }>;
}): Promise<DiscordChannelPermissionsAudit>;
export {};
