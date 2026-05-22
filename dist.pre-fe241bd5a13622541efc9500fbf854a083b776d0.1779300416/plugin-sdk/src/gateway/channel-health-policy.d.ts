import type { ChannelId } from "../channels/plugins/types.public.js";
type ChannelHealthSnapshot = {
    running?: boolean;
    connected?: boolean;
    enabled?: boolean;
    configured?: boolean;
    restartPending?: boolean;
    busy?: boolean;
    activeRuns?: number;
    lastRunActivityAt?: number | null;
    lastEventAt?: number | null;
    lastConnectedAt?: number | null;
    lastTransportActivityAt?: number | null;
    lastStartAt?: number | null;
    reconnectAttempts?: number;
    mode?: string;
};
type ChannelHealthEvaluationReason = "healthy" | "unmanaged" | "not-running" | "busy" | "stuck" | "startup-connect-grace" | "disconnected" | "stale-socket";
export type ChannelHealthEvaluation = {
    healthy: boolean;
    reason: ChannelHealthEvaluationReason;
};
export type ChannelHealthPolicy = {
    channelId: ChannelId;
    now: number;
    staleEventThresholdMs: number;
    channelConnectGraceMs: number;
};
type ChannelRestartReason = "gave-up" | "stopped" | "stale-socket" | "stuck" | "disconnected";
export declare const DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS: number;
export declare const DEFAULT_CHANNEL_CONNECT_GRACE_MS = 120000;
export declare function evaluateChannelHealth(snapshot: ChannelHealthSnapshot, policy: ChannelHealthPolicy): ChannelHealthEvaluation;
export declare function resolveChannelRestartReason(snapshot: ChannelHealthSnapshot, evaluation: ChannelHealthEvaluation): ChannelRestartReason;
export {};
