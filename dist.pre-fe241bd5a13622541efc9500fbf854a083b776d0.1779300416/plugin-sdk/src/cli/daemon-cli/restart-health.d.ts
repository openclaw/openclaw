import type { PluginHealthErrorSummary } from "../../commands/health.types.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import type { GatewayService } from "../../daemon/service.js";
import { type PortUsage } from "../../infra/ports.js";
export declare const DEFAULT_RESTART_HEALTH_TIMEOUT_MS = 60000;
export declare const DEFAULT_RESTART_HEALTH_DELAY_MS = 500;
export declare const DEFAULT_RESTART_HEALTH_ATTEMPTS: number;
export type GatewayRestartWaitOutcome = "healthy" | "plugin-errors" | "channel-errors" | "version-mismatch" | "stale-pids" | "stopped-free" | "timeout";
export type GatewayRestartSnapshot = {
    runtime: GatewayServiceRuntime;
    portUsage: PortUsage;
    healthy: boolean;
    staleGatewayPids: number[];
    gatewayVersion?: string | null;
    activatedPluginErrors?: PluginHealthErrorSummary[];
    channelProbeErrors?: Array<{
        id: string;
        error: string;
    }>;
    expectedVersion?: string;
    versionMismatch?: {
        expected: string;
        actual: string | null;
    };
    waitOutcome?: GatewayRestartWaitOutcome;
    elapsedMs?: number;
};
export type GatewayPortHealthSnapshot = {
    portUsage: PortUsage;
    healthy: boolean;
};
type GatewayRestartProbeAuth = {
    token?: string;
    password?: string;
};
export declare function inspectGatewayRestart(params: {
    service: GatewayService;
    port: number;
    env?: NodeJS.ProcessEnv;
    expectedVersion?: string | null;
    includeUnknownListenersAsStale?: boolean;
    probeAuth?: GatewayRestartProbeAuth;
}): Promise<GatewayRestartSnapshot>;
export declare function waitForGatewayHealthyRestart(params: {
    service: GatewayService;
    port: number;
    attempts?: number;
    delayMs?: number;
    env?: NodeJS.ProcessEnv;
    expectedVersion?: string | null;
    includeUnknownListenersAsStale?: boolean;
}): Promise<GatewayRestartSnapshot>;
export declare function waitForGatewayHealthyListener(params: {
    port: number;
    attempts?: number;
    delayMs?: number;
}): Promise<GatewayPortHealthSnapshot>;
export declare function renderRestartDiagnostics(snapshot: GatewayRestartSnapshot): string[];
export declare function renderGatewayPortHealthDiagnostics(snapshot: GatewayPortHealthSnapshot): string[];
export declare function terminateStaleGatewayPids(pids: number[]): Promise<number[]>;
export {};
