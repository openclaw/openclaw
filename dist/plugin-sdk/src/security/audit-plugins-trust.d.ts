import type { OpenClawConfig } from "../config/config.js";
import type { SecurityAuditFinding } from "./audit.types.js";
export declare function collectPluginsTrustFindings(params: {
    cfg: OpenClawConfig;
    stateDir: string;
}): Promise<SecurityAuditFinding[]>;
