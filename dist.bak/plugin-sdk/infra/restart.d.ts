import { findGatewayPidsOnPortSync } from "./restart-stale-pids.js";
export type RestartAttempt = {
    ok: boolean;
    method: "launchctl" | "systemd" | "supervisor";
    detail?: string;
    tried?: string[];
};
export { findGatewayPidsOnPortSync };
export type RestartAuditInfo = {
    actor?: string;
    deviceId?: string;
    clientIp?: string;
    changedPaths?: string[];
};
/**
 * Register a callback that scheduleGatewaySigusr1Restart checks before emitting SIGUSR1.
 * The callback should return the number of pending items (0 = safe to restart).
 */
export declare function setPreRestartDeferralCheck(fn: () => number): void;
/**
 * Emit an authorized SIGUSR1 gateway restart, guarded against duplicate emissions.
 * Returns true if SIGUSR1 was emitted, false if a restart was already emitted.
 * Both scheduleGatewaySigusr1Restart and the config watcher should use this
 * to ensure only one restart fires.
 */
export declare function emitGatewayRestart(): boolean;
export declare function setGatewaySigusr1RestartPolicy(opts?: {
    allowExternal?: boolean;
}): void;
export declare function isGatewaySigusr1RestartExternallyAllowed(): boolean;
export declare function consumeGatewaySigusr1RestartAuthorization(): boolean;
/**
 * Mark the currently emitted SIGUSR1 restart cycle as consumed by the run loop.
 * This explicitly advances the cycle state instead of resetting emit guards inside
 * consumeGatewaySigusr1RestartAuthorization().
 */
export declare function markGatewaySigusr1RestartHandled(): void;
export type RestartDeferralHooks = {
    onDeferring?: (pending: number) => void;
    onReady?: () => void;
    onTimeout?: (pending: number, elapsedMs: number) => void;
    onCheckError?: (err: unknown) => void;
};
/**
 * Poll pending work until it drains (or times out), then emit one restart signal.
 * Shared by both the direct RPC restart path and the config watcher path.
 */
export declare function deferGatewayRestartUntilIdle(opts: {
    getPendingCount: () => number;
    hooks?: RestartDeferralHooks;
    pollMs?: number;
    maxWaitMs?: number;
}): void;
export declare function triggerOpenClawRestart(): RestartAttempt;
export type ScheduledRestart = {
    ok: boolean;
    pid: number;
    signal: "SIGUSR1";
    delayMs: number;
    reason?: string;
    mode: "emit" | "signal";
    coalesced: boolean;
    cooldownMsApplied: number;
};
export declare function scheduleGatewaySigusr1Restart(opts?: {
    delayMs?: number;
    reason?: string;
    audit?: RestartAuditInfo;
}): ScheduledRestart;
export declare const __testing: {
    resetSigusr1State(): void;
};
