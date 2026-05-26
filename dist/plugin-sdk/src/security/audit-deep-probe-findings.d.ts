import type { SecurityAuditFinding, SecurityAuditReport } from "./audit.types.js";
export declare function collectDeepProbeFindings(params: {
    deep?: SecurityAuditReport["deep"];
    authWarning?: string;
}): SecurityAuditFinding[];
