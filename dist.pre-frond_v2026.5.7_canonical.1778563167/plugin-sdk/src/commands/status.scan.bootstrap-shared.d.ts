import type { OpenClawConfig } from "../config/types.js";
import type { UpdateCheckResult } from "../infra/update-check.js";
export declare function buildColdStartStatusSummary(): {
    runtimeVersion: null;
    heartbeat: {
        defaultAgentId: string;
        agents: never[];
    };
    channelSummary: never[];
    queuedSystemEvents: never[];
    tasks: import("../tasks/task-registry.types.ts").TaskRegistrySummary;
    taskAudit: import("../tasks/task-registry.audit.shared.js").TaskAuditSummary;
    sessions: {
        paths: never[];
        count: number;
        defaults: {
            model: null;
            contextTokens: null;
        };
        recent: never[];
        byAgent: never[];
    };
};
type StatusScanExecRunner = (command: string, args: string[], opts?: number | {
    timeoutMs?: number;
    maxBuffer?: number;
    cwd?: string;
}) => Promise<{
    stdout: string;
    stderr: string;
}>;
type StatusScanCoreBootstrapParams<TAgentStatus> = {
    coldStart: boolean;
    cfg: OpenClawConfig;
    hasConfiguredChannels: boolean;
    opts: {
        timeoutMs?: number;
        all?: boolean;
    };
    getTailnetHostname: (runner: StatusScanExecRunner) => Promise<string | null>;
    getUpdateCheckResult: (params: {
        timeoutMs: number;
        fetchGit: boolean;
        includeRegistry: boolean;
        updateConfigChannel?: string | null;
    }) => Promise<UpdateCheckResult>;
    getAgentLocalStatuses: (cfg: OpenClawConfig) => Promise<TAgentStatus>;
};
export declare function createStatusScanCoreBootstrap<TAgentStatus>(params: StatusScanCoreBootstrapParams<TAgentStatus>): Promise<{
    tailscaleMode: import("../config/types.gateway.ts").GatewayTailscaleMode;
    tailscaleDnsPromise: Promise<string | null>;
    updatePromise: Promise<UpdateCheckResult>;
    agentStatusPromise: Promise<TAgentStatus>;
    gatewayProbePromise: Promise<import("./status.scan.shared.js").GatewayProbeSnapshot>;
    skipColdStartNetworkChecks: boolean;
    resolveTailscaleHttpsUrl: () => Promise<string | null>;
}>;
export {};
