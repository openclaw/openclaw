import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/config.js";
import type { SecurityAuditFinding, SecurityAuditReport } from "./audit.types.js";
import type { ExecFn } from "./windows-acl.js";
type ExecDockerRawFn = typeof import("../agents/sandbox/docker.js").execDockerRaw;
type ProbeGatewayFn = typeof import("../gateway/probe.js").probeGateway;
export type { SecurityAuditFinding, SecurityAuditReport, SecurityAuditSeverity, SecurityAuditSummary, } from "./audit.types.js";
export type SecurityAuditOptions = {
    config: OpenClawConfig;
    sourceConfig?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    deep?: boolean;
    includeFilesystem?: boolean;
    includeChannelSecurity?: boolean;
    /** Override where to check state (default: resolveStateDir()). */
    stateDir?: string;
    /** Override config path check (default: resolveConfigPath()). */
    configPath?: string;
    /** Time limit for deep gateway probe. */
    deepTimeoutMs?: number;
    /** Dependency injection for tests. */
    plugins?: ChannelPlugin[];
    /** Whether to import plugin modules to discover plugin security audit collectors. */
    loadPluginSecurityCollectors?: boolean;
    /** Dependency injection for tests (Windows ACL checks). */
    execIcacls?: ExecFn;
    /** Dependency injection for tests (Docker label checks). */
    execDockerRawFn?: ExecDockerRawFn;
    /** Optional preloaded config snapshot to skip audit-time config file reads. */
    configSnapshot?: ConfigFileSnapshot | null;
    /** Optional cache for code-safety summaries across repeated deep audits. */
    codeSafetySummaryCache?: Map<string, Promise<unknown>>;
    /** Optional explicit auth for deep gateway probe. */
    deepProbeAuth?: {
        token?: string;
        password?: string;
    };
    /** Override workspace used for workspace plugin discovery. */
    workspaceDir?: string;
    /** Dependency injection for tests. */
    probeGatewayFn?: ProbeGatewayFn;
};
export type AuditExecutionContext = {
    cfg: OpenClawConfig;
    sourceConfig: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    includeFilesystem: boolean;
    includeChannelSecurity: boolean;
    deep: boolean;
    deepTimeoutMs: number;
    stateDir: string;
    configPath: string;
    execIcacls?: ExecFn;
    execDockerRawFn?: ExecDockerRawFn;
    probeGatewayFn?: ProbeGatewayFn;
    plugins?: ChannelPlugin[];
    loadPluginSecurityCollectors: boolean;
    configSnapshot: ConfigFileSnapshot | null;
    codeSafetySummaryCache: Map<string, Promise<unknown>>;
    deepProbeAuth?: {
        token?: string;
        password?: string;
    };
    workspaceDir?: string;
};
export declare function collectFilesystemFindings(params: {
    stateDir: string;
    configPath: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    execIcacls?: ExecFn;
}): Promise<SecurityAuditFinding[]>;
export declare function collectGatewayConfigFindings(cfg: OpenClawConfig, sourceConfig: OpenClawConfig, env: NodeJS.ProcessEnv): SecurityAuditFinding[];
export declare function collectPluginSecurityAuditFindings(context: AuditExecutionContext): Promise<SecurityAuditFinding[]>;
export declare function collectLoggingFindings(cfg: OpenClawConfig): SecurityAuditFinding[];
export declare function collectElevatedFindings(cfg: OpenClawConfig): SecurityAuditFinding[];
export declare function collectExecRuntimeFindings(cfg: OpenClawConfig): SecurityAuditFinding[];
export declare function runSecurityAudit(opts: SecurityAuditOptions): Promise<SecurityAuditReport>;
