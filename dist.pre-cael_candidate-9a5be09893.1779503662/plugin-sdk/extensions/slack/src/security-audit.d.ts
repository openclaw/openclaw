import type { ResolvedSlackAccount } from "./accounts.js";
import type { OpenClawConfig } from "./runtime-api.js";
export declare function collectSlackSecurityAuditFindings(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    account: ResolvedSlackAccount;
}): Promise<{
    checkId: string;
    severity: "info" | "warn" | "critical";
    title: string;
    detail: string;
    remediation?: string;
}[]>;
