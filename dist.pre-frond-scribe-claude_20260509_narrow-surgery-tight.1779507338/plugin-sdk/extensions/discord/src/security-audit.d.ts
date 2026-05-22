import type { ResolvedDiscordAccount } from "./accounts.js";
import type { OpenClawConfig } from "./runtime-api.js";
export declare function collectDiscordSecurityAuditFindings(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    account: ResolvedDiscordAccount;
    orderedAccountIds: string[];
    hasExplicitAccountPath: boolean;
}): Promise<{
    checkId: string;
    severity: "info" | "warn" | "critical";
    title: string;
    detail: string;
    remediation?: string;
}[]>;
