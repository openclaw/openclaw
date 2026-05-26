import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecurityAuditFinding } from "./audit.types.js";
export declare function collectDeepCodeSafetyFindings(params: {
    cfg: OpenClawConfig;
    stateDir: string;
    deep: boolean;
    summaryCache?: Map<string, Promise<unknown>>;
}): Promise<SecurityAuditFinding[]>;
