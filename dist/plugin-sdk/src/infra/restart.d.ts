import { findGatewayPidsOnPortSync } from "./restart-stale-pids.js";
import type { RestartAttempt } from "./restart.types.js";
export type { RestartAttempt } from "./restart.types.js";
export declare const DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS = 300000;
export { findGatewayPidsOnPortSync };
export declare function resetGatewayRestartStateForInProcessRestart(): void;
export type RestartAuditInfo = {
    actor?: string;
    deviceId?: string;
    clientIp?: string;
    changedPaths?: string[];
};
export type GatewayRestartIntent = {
    force?: boolean;
    waitMs?: number;
};
export declare function writeGatewayRestartIntentSync(opts: {
    env?: NodeJS.ProcessEnv;
    targetPid?: number;
    intent?: GatewayRestartIntent;
}): boolean;
export declare function clearGatewayRestartIntentSync(env?: NodeJS.ProcessEnv): void;
export declare function consumeGatewayRestartIntentPayloadSync(env?: NodeJS.ProcessEnv, now?: number): GatewayRestartIntent | null;
export declare function consumeGatewayRestartIntentSync(env?: NodeJS.ProcessEnv, now?: number): boolean;
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
export declare function emitGatewayRestart(reasonOverride?: string): boolean;
export declare function setGatewaySigusr1RestartPolicy(opts?: {
    allowExternal?: boolean;
}): void;
export declare function isGatewaySigusr1RestartExternallyAllowed(): boolean;
export declare function consumeGatewaySigusr1RestartAuthorization(): boolean;
export declare function peekGatewaySigusr1RestartReason(): string | undefined;
/**
 * Mark the currently emitted SIGUSR1 restart cycle as consumed by the run loop.
 * This explicitly advances the cycle state instead of resetting emit guards inside
 * consumeGatewaySigusr1RestartAuthorization().
 */
export declare function markGatewaySigusr1RestartHandled(): void;
export type RestartDeferralHooks = {
    onDeferring?: (pending: number) => void;
    onStillPending?: (pending: number, elapsedMs: number) => void;
    onReady?: () => void;
    onTimeout?: (pending: number, elapsedMs: number) => void;
    onCheckError?: (err: unknown) => void;
};
export type RestartEmitHooks = {
    beforeEmit?: () => Promise<void>;
    afterEmitRejected?: () => Promise<void>;
};
export declare function resolveGatewayRestartDeferralTimeoutMs(timeoutMs: unknown): number | undefined;
/**
 * Poll pending work until it drains, then emit one restart signal.
 * A positive maxWaitMs keeps the old capped behavior for explicit configs.
 * Shared by both the direct RPC restart path and the config watcher path.
 */
export declare function deferGatewayRestartUntilIdle(opts: {
    getPendingCount: () => number;
    hooks?: RestartDeferralHooks;
    emitHooks?: RestartEmitHooks;
    pollMs?: number;
    maxWaitMs?: number;
    reason?: string;
}): void;
export declare function triggerOpenClawRestart(): RestartAttempt;
export type ScheduledRestart = {
    ok: boolean;
    pid: number;
    signal: "SIGUSR1";
    delayMs: number;
    reason?: string;
    mode: "emit" | "signal" | "supervisor";
    coalesced: boolean;
    cooldownMsApplied: number;
};
export declare function scheduleGatewaySigusr1Restart(opts?: {
    delayMs?: number;
    reason?: string;
    audit?: RestartAuditInfo;
    emitHooks?: RestartEmitHooks;
    skipDeferral?: boolean;
    skipCooldown?: boolean;
}): ScheduledRestart;
export declare const __testing: {
    resetSigusr1State(): void;
};
