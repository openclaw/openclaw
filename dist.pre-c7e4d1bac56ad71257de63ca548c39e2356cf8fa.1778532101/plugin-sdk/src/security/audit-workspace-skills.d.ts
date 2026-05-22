import type { OpenClawConfig } from "../config/config.js";
import type { SecurityAuditFinding } from "./audit.types.js";
type WorkspaceSkillScanLimits = {
    maxFiles?: number;
    maxDirVisits?: number;
};
export declare function collectWorkspaceSkillSymlinkEscapeFindings(params: {
    cfg: OpenClawConfig;
    skillScanLimits?: WorkspaceSkillScanLimits;
}): Promise<SecurityAuditFinding[]>;
export {};
