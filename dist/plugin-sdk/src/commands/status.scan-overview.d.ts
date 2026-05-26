import type { OpenClawConfig } from "../config/types.js";
import type { collectChannelStatusIssues as collectChannelStatusIssuesFn } from "../infra/channels-status-issues.js";
import { resolveOsSummary } from "../infra/os-summary.js";
import type { UpdateCheckResult } from "../infra/update-check.js";
import type { RuntimeEnv } from "../runtime.js";
import type { buildChannelsTable as buildChannelsTableFn } from "./status-all/channels.js";
import type { getAgentLocalStatuses as getAgentLocalStatusesFn } from "./status.agent-local.js";
import type { GatewayProbeSnapshot } from "./status.scan.shared.js";
export type StatusScanOverviewResult = {
    coldStart: boolean;
    hasConfiguredChannels: boolean;
    skipColdStartNetworkChecks: boolean;
    cfg: OpenClawConfig;
    sourceConfig: OpenClawConfig;
    secretDiagnostics: string[];
    osSummary: ReturnType<typeof resolveOsSummary>;
    tailscaleMode: string;
    tailscaleDns: string | null;
    tailscaleHttpsUrl: string | null;
    update: UpdateCheckResult;
    gatewaySnapshot: Pick<GatewayProbeSnapshot, "gatewayConnection" | "remoteUrlMissing" | "gatewayMode" | "gatewayProbeAuth" | "gatewayProbeAuthWarning" | "gatewayProbe" | "gatewayReachable" | "gatewaySelf" | "gatewayCallOverrides">;
    channelsStatus: unknown;
    channelIssues: ReturnType<typeof collectChannelStatusIssuesFn>;
    channels: Awaited<ReturnType<typeof buildChannelsTableFn>>;
    agentStatus: Awaited<ReturnType<typeof getAgentLocalStatusesFn>>;
};
export declare function collectStatusScanOverview(params: {
    commandName: string;
    opts: {
        timeoutMs?: number;
        all?: boolean;
    };
    showSecrets: boolean;
    runtime?: RuntimeEnv;
    allowMissingConfigFastPath?: boolean;
    resolveHasConfiguredChannels?: (cfg: OpenClawConfig, sourceConfig: OpenClawConfig) => boolean;
    includeChannelsData?: boolean;
    includeLiveChannelStatus?: boolean;
    includeChannelSetupRuntimeFallback?: boolean;
    useGatewayCallOverridesForChannelsStatus?: boolean;
    progress?: {
        setLabel(label: string): void;
        tick(): void;
    };
    labels?: {
        loadingConfig?: string;
        checkingTailscale?: string;
        checkingForUpdates?: string;
        resolvingAgents?: string;
        probingGateway?: string;
        queryingChannelStatus?: string;
        summarizingChannels?: string;
    };
}): Promise<StatusScanOverviewResult>;
export declare function resolveStatusSummaryFromOverview(params: {
    overview: Pick<StatusScanOverviewResult, "skipColdStartNetworkChecks" | "cfg" | "sourceConfig">;
    includeChannelSummary?: boolean;
}): Promise<import("./status.types.ts").StatusSummary | {
    runtimeVersion: null;
    heartbeat: {
        defaultAgentId: string;
        agents: never[];
    };
    channelSummary: never[];
    queuedSystemEvents: never[];
    tasks: import("../tasks/task-registry.types.ts").TaskRegistrySummary;
    taskAudit: import("../tasks/task-registry.audit.shared.ts").TaskAuditSummary;
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
}>;
