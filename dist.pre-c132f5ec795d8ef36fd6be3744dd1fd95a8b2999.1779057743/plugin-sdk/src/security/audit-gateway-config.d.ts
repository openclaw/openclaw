import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecurityAuditFinding } from "./audit.types.js";
type CollectDangerousConfigFlags = (cfg: OpenClawConfig) => string[];
export type CollectGatewayConfigFindingsOptions = {
    collectDangerousConfigFlags?: CollectDangerousConfigFlags;
};
export declare function collectGatewayConfigFindings(cfg: OpenClawConfig, sourceConfig: OpenClawConfig, env: NodeJS.ProcessEnv, options?: CollectGatewayConfigFindingsOptions): SecurityAuditFinding[];
export {};
