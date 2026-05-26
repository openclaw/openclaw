import type { ConnectPairingRequiredReason } from "../gateway/protocol/connect-error-details.js";
import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";
import type { resolveOsSummary } from "../infra/os-summary.js";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import type { SecurityAuditReport } from "../security/audit.js";
import type { RenderTableOptions, TableColumn } from "../terminal/table.js";
import type { HealthSummary } from "./health.js";
import type { StatusOverviewSurface } from "./status-overview-surface.ts";
import type { AgentLocalStatus } from "./status.agent-local.js";
import { type StatusMemoryStateResolvers } from "./status.command-sections.js";
import type { MemoryPluginStatus, MemoryStatusSnapshot } from "./status.scan.shared.js";
import type { SessionStatus, StatusSummary } from "./status.types.js";
export declare function buildStatusCommandReportData(params: {
    opts: {
        deep?: boolean;
        verbose?: boolean;
    };
    surface: StatusOverviewSurface;
    osSummary: ReturnType<typeof resolveOsSummary>;
    summary: StatusSummary;
    securityAudit?: SecurityAuditReport;
    health?: HealthSummary;
    usageLines?: string[];
    lastHeartbeat: HeartbeatEventPayload | null;
    agentStatus: {
        defaultId?: string | null;
        bootstrapPendingCount: number;
        totalSessions: number;
        agents: AgentLocalStatus[];
    };
    channels: {
        rows: Array<{
            id: string;
            label: string;
            enabled: boolean;
            state: "ok" | "warn" | "off" | "setup";
            detail: string;
        }>;
    };
    channelIssues: Array<{
        channel: string;
        message: string;
    }>;
    memory: MemoryStatusSnapshot | null;
    memoryPlugin: MemoryPluginStatus;
    pluginCompatibility: PluginCompatibilityNotice[];
    pairingRecovery: {
        requestId: string | null;
        reason: ConnectPairingRequiredReason | null;
        remediationHint: string | null;
    } | null;
    tableWidth: number;
    ok: (value: string) => string;
    warn: (value: string) => string;
    muted: (value: string) => string;
    shortenText: (value: string, maxLen: number) => string;
    formatCliCommand: (value: string) => string;
    formatTimeAgo: (ageMs: number) => string;
    formatKTokens: (value: number) => string;
    formatTokensCompact: (value: SessionStatus) => string;
    formatPromptCacheCompact: (value: SessionStatus) => string | null;
    formatHealthChannelLines: (summary: HealthSummary, opts: {
        accountMode: "all";
    }) => string[];
    formatPluginCompatibilityNotice: (notice: PluginCompatibilityNotice) => string;
    formatUpdateAvailableHint: (update: StatusOverviewSurface["update"]) => string | null;
    accentDim: (value: string) => string;
    updateValue?: string;
    theme: {
        heading: (value: string) => string;
        muted: (value: string) => string;
        warn: (value: string) => string;
        error: (value: string) => string;
    };
    renderTable: (input: RenderTableOptions) => string;
} & StatusMemoryStateResolvers): Promise<{
    heading: (value: string) => string;
    muted: (value: string) => string;
    renderTable: (input: RenderTableOptions) => string;
    width: number;
    overviewRows: import("./status-all/format.ts").StatusOverviewRow[];
    showTaskMaintenanceHint: boolean;
    taskMaintenanceHint: string;
    pluginCompatibilityLines: string[];
    pairingRecoveryLines: string[];
    securityAuditLines: string[];
    channelsColumns: readonly [{
        readonly key: "Channel";
        readonly header: "Channel";
        readonly minWidth: 10;
    }, {
        readonly key: "Enabled";
        readonly header: "Enabled";
        readonly minWidth: 7;
    }, {
        readonly key: "State";
        readonly header: "State";
        readonly minWidth: 8;
    }, {
        readonly key: "Detail";
        readonly header: "Detail";
        readonly flex: true;
        readonly minWidth: 24;
    }];
    channelsRows: {
        Channel: string;
        Enabled: string;
        State: string;
        Detail: string;
    }[];
    sessionsColumns: ({
        key: string;
        header: string;
        minWidth: number;
        flex?: undefined;
    } | {
        key: string;
        header: string;
        minWidth: number;
        flex: boolean;
    })[];
    sessionsRows: {
        Key: string;
        Kind: string;
        Age: string;
        Model: string;
        Runtime: string;
        Tokens: string;
        Cache?: string | undefined;
    }[];
    systemEventsRows: {
        Event: string;
    }[] | undefined;
    systemEventsTrailer: string | null;
    healthColumns: TableColumn[] | undefined;
    healthRows: Record<string, string>[] | undefined;
    usageLines: string[] | undefined;
    footerLines: string[];
}>;
