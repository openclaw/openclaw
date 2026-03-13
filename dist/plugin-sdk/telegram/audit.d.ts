import type { TelegramGroupConfig } from "../config/types.js";
import type { TelegramNetworkConfig } from "../config/types.telegram.js";
export type TelegramGroupMembershipAuditEntry = {
    chatId: string;
    ok: boolean;
    status?: string | null;
    error?: string | null;
    matchKey?: string;
    matchSource?: "id";
};
export type TelegramGroupMembershipAudit = {
    ok: boolean;
    checkedGroups: number;
    unresolvedGroups: number;
    hasWildcardUnmentionedGroups: boolean;
    groups: TelegramGroupMembershipAuditEntry[];
    elapsedMs: number;
};
export declare function collectTelegramUnmentionedGroupIds(groups: Record<string, TelegramGroupConfig> | undefined): {
    groupIds: string[];
    unresolvedGroups: number;
    hasWildcardUnmentionedGroups: boolean;
};
export type AuditTelegramGroupMembershipParams = {
    token: string;
    botId: number;
    groupIds: string[];
    proxyUrl?: string;
    network?: TelegramNetworkConfig;
    timeoutMs: number;
};
export declare function auditTelegramGroupMembership(params: AuditTelegramGroupMembershipParams): Promise<TelegramGroupMembershipAudit>;
