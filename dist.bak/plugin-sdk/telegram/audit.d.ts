import type { TelegramGroupConfig } from "../config/types.js";
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
export declare function auditTelegramGroupMembership(params: {
    token: string;
    botId: number;
    groupIds: string[];
    proxyUrl?: string;
    timeoutMs: number;
}): Promise<TelegramGroupMembershipAudit>;
