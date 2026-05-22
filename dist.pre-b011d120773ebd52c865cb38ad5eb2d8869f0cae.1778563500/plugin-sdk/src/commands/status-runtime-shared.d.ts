import type { OpenClawConfig } from "../config/types.js";
import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";
import type { HealthSummary } from "./health.js";
export declare function resolveStatusSecurityAudit(params: {
    config: OpenClawConfig;
    sourceConfig: OpenClawConfig;
}): Promise<import("../security/audit.types.ts").SecurityAuditReport>;
export declare function resolveStatusUsageSummary(timeoutMs?: number): Promise<import("../infra/provider-usage.types.ts").UsageSummary>;
export declare function loadStatusProviderUsageModule(): Promise<typeof import("../infra/provider-usage.js")>;
export declare function resolveStatusGatewayHealth(params: {
    config: OpenClawConfig;
    timeoutMs?: number;
}): Promise<HealthSummary>;
export declare function resolveStatusGatewayHealthSafe(params: {
    config: OpenClawConfig;
    timeoutMs?: number;
    gatewayReachable: boolean;
    gatewayProbeError?: string | null;
    callOverrides?: {
        url: string;
        token?: string;
        password?: string;
    };
}): Promise<HealthSummary | {
    error: string;
}>;
export declare function resolveStatusLastHeartbeat(params: {
    config: OpenClawConfig;
    timeoutMs?: number;
    gatewayReachable: boolean;
}): Promise<HeartbeatEventPayload | null>;
export declare function resolveStatusServiceSummaries(): Promise<[{
    label: string;
    installed: boolean | null;
    loaded: boolean;
    managedByOpenClaw: boolean;
    externallyManaged: boolean;
    loadedText: string;
    runtime: Awaited<ReturnType<typeof import("./status.service-summary.ts").readServiceStatusSummary>>["runtime"];
    runtimeShort: string | null;
    layout: Awaited<ReturnType<typeof import("./status.service-summary.ts").readServiceStatusSummary>>["layout"];
}, {
    label: string;
    installed: boolean | null;
    loaded: boolean;
    managedByOpenClaw: boolean;
    externallyManaged: boolean;
    loadedText: string;
    runtime: Awaited<ReturnType<typeof import("./status.service-summary.ts").readServiceStatusSummary>>["runtime"];
    runtimeShort: string | null;
    layout: Awaited<ReturnType<typeof import("./status.service-summary.ts").readServiceStatusSummary>>["layout"];
}]>;
type StatusUsageSummary = Awaited<ReturnType<typeof resolveStatusUsageSummary>>;
type StatusGatewayHealth = Awaited<ReturnType<typeof resolveStatusGatewayHealth>>;
type StatusSecurityAudit = Awaited<ReturnType<typeof resolveStatusSecurityAudit>>;
export declare function resolveStatusRuntimeDetails(params: {
    config: OpenClawConfig;
    timeoutMs?: number;
    usage?: boolean;
    deep?: boolean;
    gatewayReachable: boolean;
    suppressHealthErrors?: boolean;
    resolveUsage?: (timeoutMs?: number) => Promise<StatusUsageSummary>;
    resolveHealth?: (input: {
        config: OpenClawConfig;
        timeoutMs?: number;
    }) => Promise<StatusGatewayHealth>;
}): Promise<{
    usage: import("../infra/provider-usage.types.ts").UsageSummary | undefined;
    health: HealthSummary | undefined;
    lastHeartbeat: HeartbeatEventPayload | null;
    gatewayService: {
        label: string;
        installed: boolean | null;
        loaded: boolean;
        managedByOpenClaw: boolean;
        externallyManaged: boolean;
        loadedText: string;
        runtime: Awaited<ReturnType<typeof import("./status.service-summary.ts").readServiceStatusSummary>>["runtime"];
        runtimeShort: string | null;
        layout: Awaited<ReturnType<typeof import("./status.service-summary.ts").readServiceStatusSummary>>["layout"];
    };
    nodeService: {
        label: string;
        installed: boolean | null;
        loaded: boolean;
        managedByOpenClaw: boolean;
        externallyManaged: boolean;
        loadedText: string;
        runtime: Awaited<ReturnType<typeof import("./status.service-summary.ts").readServiceStatusSummary>>["runtime"];
        runtimeShort: string | null;
        layout: Awaited<ReturnType<typeof import("./status.service-summary.ts").readServiceStatusSummary>>["layout"];
    };
}>;
export declare function resolveStatusRuntimeSnapshot(params: {
    config: OpenClawConfig;
    sourceConfig: OpenClawConfig;
    timeoutMs?: number;
    usage?: boolean;
    deep?: boolean;
    gatewayReachable: boolean;
    includeSecurityAudit?: boolean;
    suppressHealthErrors?: boolean;
    resolveSecurityAudit?: (input: {
        config: OpenClawConfig;
        sourceConfig: OpenClawConfig;
    }) => Promise<StatusSecurityAudit>;
    resolveUsage?: (timeoutMs?: number) => Promise<StatusUsageSummary>;
    resolveHealth?: (input: {
        config: OpenClawConfig;
        timeoutMs?: number;
    }) => Promise<StatusGatewayHealth>;
}): Promise<{
    usage: import("../infra/provider-usage.types.ts").UsageSummary | undefined;
    health: HealthSummary | undefined;
    lastHeartbeat: HeartbeatEventPayload | null;
    gatewayService: {
        label: string;
        installed: boolean | null;
        loaded: boolean;
        managedByOpenClaw: boolean;
        externallyManaged: boolean;
        loadedText: string;
        runtime: Awaited<ReturnType<typeof import("./status.service-summary.ts").readServiceStatusSummary>>["runtime"];
        runtimeShort: string | null;
        layout: Awaited<ReturnType<typeof import("./status.service-summary.ts").readServiceStatusSummary>>["layout"];
    };
    nodeService: {
        label: string;
        installed: boolean | null;
        loaded: boolean;
        managedByOpenClaw: boolean;
        externallyManaged: boolean;
        loadedText: string;
        runtime: Awaited<ReturnType<typeof import("./status.service-summary.ts").readServiceStatusSummary>>["runtime"];
        runtimeShort: string | null;
        layout: Awaited<ReturnType<typeof import("./status.service-summary.ts").readServiceStatusSummary>>["layout"];
    };
    securityAudit: import("../security/audit.types.ts").SecurityAuditReport | undefined;
}>;
export {};
