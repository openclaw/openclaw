import type { OpenClawConfig } from "../config/config.js";
export type DiscordChannelPermissionsAuditEntry = {
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
export declare function collectDiscordAuditChannelIds(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): {
    channelIds: string[];
    unresolvedChannels: number;
};
export declare function auditDiscordChannelPermissions(params: {
    token: string;
    accountId?: string | null;
    channelIds: string[];
    timeoutMs: number;
}): Promise<DiscordChannelPermissionsAudit>;
