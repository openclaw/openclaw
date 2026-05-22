import type { SecurityAuditFinding } from "../security/audit.types.js";
type FacadeModule = {
    collectSynologyChatSecurityAuditFindings: (params: {
        accountId?: string | null;
        account: {
            accountId?: string;
            dangerouslyAllowNameMatching?: boolean;
        };
        orderedAccountIds: string[];
        hasExplicitAccountPath: boolean;
    }) => SecurityAuditFinding[];
};
export declare const collectSynologyChatSecurityAuditFindings: FacadeModule["collectSynologyChatSecurityAuditFindings"];
export {};
