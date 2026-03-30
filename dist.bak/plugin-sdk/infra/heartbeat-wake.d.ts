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
export type HeartbeatWakeHandler = (opts: {
    reason?: string;
    agentId?: string;
    sessionKey?: string;
}) => Promise<HeartbeatRunResult>;
/**
 * Register (or clear) the heartbeat wake handler.
 * Returns a disposer function that clears this specific registration.
 * Stale disposers (from previous registrations) are no-ops, preventing
 * a race where an old runner's cleanup clears a newer runner's handler.
 */
export declare function setHeartbeatWakeHandler(next: HeartbeatWakeHandler | null): () => void;
export declare function requestHeartbeatNow(opts?: {
    reason?: string;
    coalesceMs?: number;
    agentId?: string;
    sessionKey?: string;
}): void;
export declare function hasHeartbeatWakeHandler(): boolean;
export declare function hasPendingHeartbeatWake(): boolean;
export declare function resetHeartbeatWakeStateForTests(): void;
