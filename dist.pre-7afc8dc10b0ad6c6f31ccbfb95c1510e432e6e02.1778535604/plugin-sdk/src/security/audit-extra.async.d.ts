import type { OpenClawConfig, ConfigFileSnapshot } from "../config/config.js";
import type { ExecFn } from "./windows-acl.js";
export type SecurityAuditFinding = {
    checkId: string;
    severity: "info" | "warn" | "critical";
    title: string;
    detail: string;
    remediation?: string;
};
type CollectPluginsTrustFindingsParams = Parameters<typeof import("./audit-plugins-trust.js").collectPluginsTrustFindings>[0];
type ExecDockerRawFn = (args: string[], opts?: {
    allowFailure?: boolean;
    input?: Buffer | string;
    signal?: AbortSignal;
}) => Promise<import("../agents/sandbox/docker.js").ExecDockerRawResult>;
type CodeSafetySummaryCache = Map<string, Promise<unknown>>;
export declare function collectPluginsTrustFindings(params: CollectPluginsTrustFindingsParams): Promise<SecurityAuditFinding[]>;
export declare function collectSandboxBrowserHashLabelFindings(params?: {
    execDockerRawFn?: ExecDockerRawFn;
}): Promise<SecurityAuditFinding[]>;
export declare function collectIncludeFilePermFindings(params: {
    configSnapshot: ConfigFileSnapshot;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    execIcacls?: ExecFn;
}): Promise<SecurityAuditFinding[]>;
export declare function collectStateDeepFilesystemFindings(params: {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    stateDir: string;
    platform?: NodeJS.Platform;
    execIcacls?: ExecFn;
}): Promise<SecurityAuditFinding[]>;
export declare function readConfigSnapshotForAudit(params: {
    env: NodeJS.ProcessEnv;
    configPath: string;
}): Promise<ConfigFileSnapshot>;
export declare function collectPluginsCodeSafetyFindings(params: {
    stateDir: string;
    summaryCache?: CodeSafetySummaryCache;
}): Promise<SecurityAuditFinding[]>;
export declare function collectInstalledSkillsCodeSafetyFindings(params: {
    cfg: OpenClawConfig;
    stateDir: string;
    summaryCache?: CodeSafetySummaryCache;
}): Promise<SecurityAuditFinding[]>;
export {};
