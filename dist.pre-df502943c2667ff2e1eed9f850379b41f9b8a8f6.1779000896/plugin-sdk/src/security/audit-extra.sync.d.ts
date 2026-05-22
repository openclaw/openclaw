import type { OpenClawConfig } from "../config/types.openclaw.js";
/**
 * Synchronous security audit collector functions.
 *
 * These functions analyze config-based security properties without I/O.
 */
export type SecurityAuditFinding = {
    checkId: string;
    severity: "info" | "warn" | "critical";
    title: string;
    detail: string;
    remediation?: string;
};
export declare function collectSyncedFolderFindings(params: {
    stateDir: string;
    configPath: string;
}): SecurityAuditFinding[];
export declare function collectSecretsInConfigFindings(cfg: OpenClawConfig): SecurityAuditFinding[];
export declare function collectHooksHardeningFindings(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): SecurityAuditFinding[];
export declare function collectGatewayHttpSessionKeyOverrideFindings(cfg: OpenClawConfig): SecurityAuditFinding[];
export declare function collectGatewayHttpNoAuthFindings(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): SecurityAuditFinding[];
export declare function collectSandboxDockerNoopFindings(cfg: OpenClawConfig): SecurityAuditFinding[];
export declare function collectSandboxDangerousConfigFindings(cfg: OpenClawConfig): SecurityAuditFinding[];
export declare function collectNodeDenyCommandPatternFindings(cfg: OpenClawConfig): SecurityAuditFinding[];
export declare function collectNodeDangerousAllowCommandFindings(cfg: OpenClawConfig): SecurityAuditFinding[];
export declare function collectMinimalProfileOverrideFindings(cfg: OpenClawConfig): SecurityAuditFinding[];
export declare function collectModelHygieneFindings(cfg: OpenClawConfig): SecurityAuditFinding[];
export declare function collectExposureMatrixFindings(cfg: OpenClawConfig): SecurityAuditFinding[];
export declare function collectLikelyMultiUserSetupFindings(cfg: OpenClawConfig): SecurityAuditFinding[];
