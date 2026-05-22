import type { OpenClawConfig } from "../../config/types.js";
import { type UpdateCheckResult } from "../../infra/update-check.js";
export { formatTimeAgo } from "../../infra/format-time/format-relative.ts";
export type StatusOverviewRow = {
    Item: string;
    Value: string;
};
type StatusUpdateLike = UpdateCheckResult;
type StatusGatewayConnection = {
    url: string;
    urlSource?: string;
};
type StatusGatewayProbe = {
    connectLatencyMs?: number | null;
    error?: string | null;
} | null;
type StatusGatewayProbeAuth = {
    token?: string;
    password?: string;
} | null;
type StatusGatewaySelf = {
    host?: string | null;
    ip?: string | null;
    version?: string | null;
    platform?: string | null;
} | null | undefined;
type StatusManagedService = {
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
export declare function resolveStatusUpdateChannelInfo(params: {
    updateConfigChannel?: string | null;
    update: {
        installKind?: UpdateCheckResult["installKind"];
        git?: {
            tag?: string | null;
            branch?: string | null;
        } | null;
    };
}): {
    channel: import("../../infra/update-channels.js").UpdateChannel;
    source: import("../../infra/update-channels.js").UpdateChannelSource;
    label: string;
};
export declare function buildStatusUpdateSurface(params: {
    updateConfigChannel?: string | null;
    update: StatusUpdateLike;
}): {
    channelInfo: {
        channel: import("../../infra/update-channels.js").UpdateChannel;
        source: import("../../infra/update-channels.js").UpdateChannelSource;
        label: string;
    };
    channelLabel: string;
    gitLabel: string | null;
    updateLine: string;
    updateAvailable: boolean;
};
export declare function formatStatusDashboardValue(value: string | null | undefined): string;
export declare function formatStatusTailscaleValue(params: {
    tailscaleMode: string;
    dnsName?: string | null;
    httpsUrl?: string | null;
    backendState?: string | null;
    includeBackendStateWhenOff?: boolean;
    includeBackendStateWhenOn?: boolean;
    includeDnsNameWhenOff?: boolean;
    decorateOff?: (value: string) => string;
    decorateWarn?: (value: string) => string;
}): string;
export declare function formatStatusServiceValue(params: {
    label: string;
    installed: boolean;
    managedByOpenClaw?: boolean;
    loadedText: string;
    runtimeShort?: string | null;
    runtimeStatus?: string | null;
    runtimePid?: number | null;
}): string;
export declare function resolveStatusDashboardUrl(params: {
    cfg: Pick<OpenClawConfig, "gateway">;
}): string | null;
export declare function buildStatusOverviewRows(params: {
    prefixRows?: StatusOverviewRow[];
    dashboardValue: string;
    tailscaleValue: string;
    channelLabel: string;
    gitLabel?: string | null;
    updateValue: string;
    gatewayValue: string;
    gatewayAuthWarning?: string | null;
    middleRows?: StatusOverviewRow[];
    gatewaySelfValue?: string | null;
    gatewayServiceValue: string;
    nodeServiceValue: string;
    agentsValue: string;
    suffixRows?: StatusOverviewRow[];
}): StatusOverviewRow[];
export declare function buildStatusOverviewSurfaceRows(params: {
    cfg: Pick<OpenClawConfig, "update" | "gateway">;
    update: StatusUpdateLike;
    tailscaleMode: string;
    tailscaleDns?: string | null;
    tailscaleHttpsUrl?: string | null;
    tailscaleBackendState?: string | null;
    includeBackendStateWhenOff?: boolean;
    includeBackendStateWhenOn?: boolean;
    includeDnsNameWhenOff?: boolean;
    decorateTailscaleOff?: (value: string) => string;
    decorateTailscaleWarn?: (value: string) => string;
    gatewayMode: "local" | "remote";
    remoteUrlMissing: boolean;
    gatewayConnection: StatusGatewayConnection;
    gatewayReachable: boolean;
    gatewayProbe: StatusGatewayProbe;
    gatewayProbeAuth: StatusGatewayProbeAuth;
    gatewayProbeAuthWarning?: string | null;
    gatewaySelf: StatusGatewaySelf;
    gatewayService: StatusManagedService;
    nodeService: StatusManagedService;
    nodeOnlyGateway?: {
        gatewayValue: string;
    } | null;
    decorateOk?: (value: string) => string;
    decorateWarn?: (value: string) => string;
    prefixRows?: StatusOverviewRow[];
    middleRows?: StatusOverviewRow[];
    suffixRows?: StatusOverviewRow[];
    agentsValue: string;
    updateValue?: string;
    gatewayAuthWarningValue?: string | null;
    gatewaySelfFallbackValue?: string | null;
}): StatusOverviewRow[];
export declare function formatGatewayAuthUsed(auth: {
    token?: string;
    password?: string;
} | null): "token" | "password" | "token+password" | "none";
export declare function formatGatewaySelfSummary(gatewaySelf: StatusGatewaySelf): string | null;
export declare function buildGatewayStatusSummaryParts(params: {
    gatewayMode: "local" | "remote";
    remoteUrlMissing: boolean;
    gatewayConnection: StatusGatewayConnection;
    gatewayReachable: boolean;
    gatewayProbe: StatusGatewayProbe;
    gatewayProbeAuth: StatusGatewayProbeAuth;
}): {
    targetText: string;
    targetTextWithSource: string;
    reachText: string;
    authText: string;
    modeLabel: string;
};
export declare function buildStatusGatewaySurfaceValues(params: {
    cfg: Pick<OpenClawConfig, "gateway">;
    gatewayMode: "local" | "remote";
    remoteUrlMissing: boolean;
    gatewayConnection: StatusGatewayConnection;
    gatewayReachable: boolean;
    gatewayProbe: StatusGatewayProbe;
    gatewayProbeAuth: StatusGatewayProbeAuth;
    gatewaySelf: StatusGatewaySelf;
    gatewayService: StatusManagedService;
    nodeService: StatusManagedService;
    nodeOnlyGateway?: {
        gatewayValue: string;
    } | null;
    decorateOk?: (value: string) => string;
    decorateWarn?: (value: string) => string;
}): {
    dashboardUrl: string | null;
    gatewayValue: string;
    gatewaySelfValue: string | null;
    gatewayServiceValue: string;
    nodeServiceValue: string;
};
export declare function buildGatewayStatusJsonPayload(params: {
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
    gatewaySelf: {
        host?: string | null;
        ip?: string | null;
        version?: string | null;
        platform?: string | null;
    } | null | undefined;
    gatewayProbeAuthWarning?: string | null;
}): {
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
export declare function redactSecrets(text: string): string;
