import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { type DiscordChannelPermissionsAudit } from "./audit-core.js";
export declare function collectDiscordAuditChannelIds(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): {
    channelIds: string[];
    unresolvedChannels: number;
};
export declare function auditDiscordChannelPermissions(params: {
    cfg: OpenClawConfig;
    token: string;
    accountId?: string | null;
    channelIds: string[];
    timeoutMs: number;
}): Promise<DiscordChannelPermissionsAudit>;
