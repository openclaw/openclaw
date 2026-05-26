import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import type { HealthSummary } from "./health.js";
import { type StatusOverviewSurface } from "./status-overview-surface.ts";
import type { AgentLocalStatus } from "./status.agent-local.js";
import { type StatusMemoryStateResolvers } from "./status.command-sections.js";
import type { MemoryPluginStatus, MemoryStatusSnapshot } from "./status.scan.shared.js";
import type { StatusSummary } from "./status.types.js";
export declare function buildStatusCommandOverviewRows(params: {
    opts: {
        deep?: boolean;
    };
    surface: StatusOverviewSurface;
    osLabel: string;
    summary: StatusSummary;
    health?: HealthSummary;
    lastHeartbeat: HeartbeatEventPayload | null;
    agentStatus: {
        defaultId?: string | null;
        bootstrapPendingCount: number;
        totalSessions: number;
        agents: AgentLocalStatus[];
    };
    memory: MemoryStatusSnapshot | null;
    memoryPlugin: MemoryPluginStatus;
    pluginCompatibility: PluginCompatibilityNotice[];
    ok: (value: string) => string;
    warn: (value: string) => string;
    muted: (value: string) => string;
    formatTimeAgo: (ageMs: number) => string;
    formatKTokens: (value: number) => string;
    updateValue?: string;
} & StatusMemoryStateResolvers): import("./status-all/format.ts").StatusOverviewRow[];
export declare function buildStatusAllOverviewRows(params: {
    surface: StatusOverviewSurface;
    osLabel: string;
    configPath: string;
    secretDiagnosticsCount: number;
    agentStatus: {
        bootstrapPendingCount: number;
        totalSessions: number;
        agents: Array<{
            id: string;
            lastActiveAgeMs?: number | null;
        }>;
    };
    tailscaleBackendState?: string | null;
}): import("./status-all/format.ts").StatusOverviewRow[];
