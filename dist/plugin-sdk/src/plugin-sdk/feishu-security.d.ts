import type { OpenClawConfig } from "../config/types.js";
import type { SecurityAuditFinding } from "../security/audit.types.js";
type SecuritySurface = {
    collectFeishuSecurityAuditFindings: (params: {
        cfg: OpenClawConfig;
    }) => SecurityAuditFinding[];
};
export declare const collectFeishuSecurityAuditFindings: SecuritySurface["collectFeishuSecurityAuditFindings"];
export {};
