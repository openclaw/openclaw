import type { OpenClawConfig } from "../../config/types.js";
import { type GatewayProbeCapability, type GatewayProbeResult } from "../../gateway/probe.js";
import { pickGatewaySelfPresence } from "../gateway-presence.js";
type TargetKind = "explicit" | "configRemote" | "localLoopback" | "sshTunnel";
export type GatewayStatusTarget = {
    id: string;
    kind: TargetKind;
    url: string;
    active: boolean;
    tunnel?: {
        kind: "ssh";
        target: string;
        localPort: number;
        remotePort: number;
        pid: number | null;
    };
};
export type GatewayConfigSummary = {
    path: string | null;
    exists: boolean;
    valid: boolean;
    issues: Array<{
        path: string;
        message: string;
    }>;
    legacyIssues: Array<{
        path: string;
        message: string;
    }>;
    gateway: {
        mode: string | null;
        bind: string | null;
        port: number | null;
        controlUiEnabled: boolean | null;
        controlUiBasePath: string | null;
        authMode: string | null;
        authTokenConfigured: boolean;
        authPasswordConfigured: boolean;
        remoteUrl: string | null;
        remoteTokenConfigured: boolean;
        remotePasswordConfigured: boolean;
        tailscaleMode: string | null;
    };
    discovery: {
        wideAreaEnabled: boolean | null;
    };
};
export declare function parseTimeoutMs(raw: unknown, fallbackMs: number): number;
export declare function resolveTargets(cfg: OpenClawConfig, explicitUrl?: string): GatewayStatusTarget[];
export declare function resolveProbeBudgetMs(overallMs: number, target: Pick<GatewayStatusTarget, "kind" | "active" | "url">): number;
export declare function sanitizeSshTarget(value: unknown): string | null;
export declare function resolveAuthForTarget(cfg: OpenClawConfig, target: GatewayStatusTarget, overrides: {
    token?: string;
    password?: string;
}): Promise<{
    token?: string;
    password?: string;
    diagnostics?: string[];
}>;
export { pickGatewaySelfPresence };
export declare function extractConfigSummary(snapshotUnknown: unknown): GatewayConfigSummary;
export declare function buildNetworkHints(cfg: OpenClawConfig): {
    localLoopbackUrl: string;
    localTailnetUrl: string | null;
    tailnetIPv4: string | null;
};
export declare function renderTargetHeader(target: GatewayStatusTarget, rich: boolean): string;
export declare function isScopeLimitedProbeFailure(probe: GatewayProbeResult): boolean;
export declare function isPostConnectProbeFailure(probe: GatewayProbeResult): boolean;
export declare function isProbeReachable(probe: GatewayProbeResult): boolean;
export declare function summarizeGatewayProbeCapability(probes: GatewayProbeResult[]): GatewayProbeCapability;
export declare function renderProbeSummaryLine(probe: GatewayProbeResult, rich: boolean): string;
