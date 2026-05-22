import type { OpenClawConfig } from "../config/types.js";
import type { UpdateCheckResult } from "../infra/update-check.js";
type StatusJsonScanLike = {
    cfg: OpenClawConfig;
    sourceConfig: OpenClawConfig;
    summary: Record<string, unknown>;
    update: UpdateCheckResult;
    osSummary: unknown;
    memory: unknown;
    memoryPlugin: unknown;
    gatewayMode: "local" | "remote";
    gatewayConnection: {
        url: string;
        urlSource?: string;
    };
    remoteUrlMissing: boolean;
    gatewayReachable: boolean;
    gatewayProbe: {
        connectLatencyMs?: number | null;
        error?: string | null;
    } | null | undefined;
    gatewayProbeAuth: {
        token?: string;
        password?: string;
    } | null | undefined;
    gatewaySelf: {
        host?: string | null;
        ip?: string | null;
        version?: string | null;
        platform?: string | null;
    } | null | undefined;
    gatewayProbeAuthWarning?: string | null;
    agentStatus: unknown;
    secretDiagnostics: string[];
    pluginCompatibility?: Array<Record<string, unknown>> | null | undefined;
};
export declare function resolveStatusJsonOutput(params: {
    scan: StatusJsonScanLike;
    opts: {
        deep?: boolean;
        usage?: boolean;
        timeoutMs?: number;
    };
    includeSecurityAudit: boolean;
    includePluginCompatibility?: boolean;
    suppressHealthErrors?: boolean;
}): Promise<{
    os: unknown;
    update: UpdateCheckResult;
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
}>;
export {};
