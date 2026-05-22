import { type StatusOverviewSurface } from "./status-overview-surface.ts";
export declare function buildStatusJsonPayload(params: {
    summary: Record<string, unknown>;
    surface: StatusOverviewSurface;
    osSummary: unknown;
    memory: unknown;
    memoryPlugin: unknown;
    agents: unknown;
    secretDiagnostics: string[];
    securityAudit?: unknown;
    health?: unknown;
    usage?: unknown;
    lastHeartbeat?: unknown;
    pluginCompatibility?: Array<Record<string, unknown>> | null | undefined;
}): {
    os: unknown;
    update: import("../infra/update-check.ts").UpdateCheckResult;
    updateChannel: import("../infra/update-channels.ts").UpdateChannel;
    updateChannelSource: import("../infra/update-channels.ts").UpdateChannelSource;
    memory: unknown;
    memoryPlugin: unknown;
    gateway: {
        mode: "local" | "remote";
        url: string;
        urlSource: string | undefined;
        misconfigured: boolean;
        reachable: boolean;
        connectLatencyMs: number | null;
        self: {
            host?: string | null;
            ip?: string | null;
            version?: string | null;
            platform?: string | null;
        } | null;
        error: string | null;
        authWarning: string | null;
    };
    gatewayService: {
        label: string;
        installed: boolean | null;
        managedByOpenClaw?: boolean;
        loadedText: string;
        runtimeShort?: string | null;
        runtime?: {
            status?: string | null;
            pid?: number | null;
        } | null;
    };
    nodeService: {
        label: string;
        installed: boolean | null;
        managedByOpenClaw?: boolean;
        loadedText: string;
        runtimeShort?: string | null;
        runtime?: {
            status?: string | null;
            pid?: number | null;
        } | null;
    };
    agents: unknown;
    secretDiagnostics: string[];
    securityAudit?: {} | undefined;
    pluginCompatibility?: {
        count: number;
        warnings: Record<string, unknown>[];
    } | undefined;
    health?: unknown;
    usage?: unknown;
    lastHeartbeat?: unknown;
};
