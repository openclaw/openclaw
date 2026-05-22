export type HeartbeatRunResult = {
    status: "ran";
    durationMs: number;
} | {
    status: "skipped";
    reason: string;
} | {
    status: "failed";
    reason: string;
};
export declare const HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT = "requests-in-flight";
export declare const HEARTBEAT_SKIP_CRON_IN_PROGRESS = "cron-in-progress";
export declare const HEARTBEAT_SKIP_LANES_BUSY = "lanes-busy";
export type RetryableHeartbeatBusySkipReason = typeof HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT | typeof HEARTBEAT_SKIP_CRON_IN_PROGRESS | typeof HEARTBEAT_SKIP_LANES_BUSY;
export declare function isRetryableHeartbeatBusySkipReason(reason: string): boolean;
export type HeartbeatWakeIntent = "scheduled" | "event" | "immediate" | "manual";
export type HeartbeatWakeSource = "interval" | "manual" | "exec-event" | "notifications-event" | "cron" | "hook" | "background-task" | "background-task-blocked" | "acp-spawn" | "cli-watchdog" | "restart-sentinel" | "retry" | "other";
export type HeartbeatWakeOverride = {
    target?: string;
    to?: string | undefined;
    accountId?: string | undefined;
};
export type HeartbeatWakeRequest = {
    source: HeartbeatWakeSource;
    intent: HeartbeatWakeIntent;
    reason?: string;
    agentId?: string;
    sessionKey?: string;
    heartbeat?: HeartbeatWakeOverride;
};
export type HeartbeatWakeHandler = (opts: HeartbeatWakeRequest) => Promise<HeartbeatRunResult>;
export declare function setHeartbeatsEnabled(enabled: boolean): void;
export declare function areHeartbeatsEnabled(): boolean;
/**
 * Register (or clear) the heartbeat wake handler.
 * Returns a disposer function that clears this specific registration.
 * Stale disposers (from previous registrations) are no-ops, preventing
 * a race where an old runner's cleanup clears a newer runner's handler.
 */
export declare function setHeartbeatWakeHandler(next: HeartbeatWakeHandler | null): () => void;
export declare function requestHeartbeat(opts: {
    source: HeartbeatWakeSource;
    intent: HeartbeatWakeIntent;
    reason?: string;
    coalesceMs?: number;
    agentId?: string;
    sessionKey?: string;
    heartbeat?: HeartbeatWakeOverride;
}): void;
export declare function hasHeartbeatWakeHandler(): boolean;
export declare function hasPendingHeartbeatWake(): boolean;
export declare function resetHeartbeatWakeStateForTests(): void;
