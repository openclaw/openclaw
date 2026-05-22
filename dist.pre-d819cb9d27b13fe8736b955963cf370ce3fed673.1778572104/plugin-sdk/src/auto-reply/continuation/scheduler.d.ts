/**
 * Continuation scheduler — chain/cost enforcement and turn scheduling.
 *
 * Handles the post-response decision: should we schedule another turn (work)
 * or dispatch a delegate? Enforces maxChainLength, costCapTokens, and delay
 * clamping. Arms timers for delayed work/delegates.
 *
 * NO generation guard. Delayed work survives channel noise by design.
 * Safety mechanisms: chain depth, token budget, per-turn delegate cap, delay bounds.
 *
 * RFC: docs/design/continue-work-signal-v2.md §3.1–§3.4
 */
import type { ChainState, ContinuationRuntimeConfig, ContinuationSignal } from "./types.js";
export type { ChainState } from "./types.js";
export type ScheduleWorkResult = {
    outcome: "scheduled";
    timerHandle: ReturnType<typeof setTimeout>;
    nextChainCount: number;
} | {
    outcome: "chain-capped";
} | {
    outcome: "cost-capped";
};
export type ScheduleDelegateResult = {
    outcome: "scheduled-immediate";
    nextChainCount: number;
} | {
    outcome: "scheduled-delayed";
    reservationId: string;
    nextChainCount: number;
} | {
    outcome: "chain-capped";
} | {
    outcome: "cost-capped";
};
/**
 * Check chain and cost caps. Returns null if clear to proceed, or the
 * rejection reason.
 */
export declare function checkContinuationBudget(params: {
    chainState: ChainState;
    config: ContinuationRuntimeConfig;
    sessionKey: string;
    highestReservationHop?: number;
}): "chain-capped" | "cost-capped" | null;
/**
 * Schedule a WORK continuation turn after a delay.
 *
 * Arms a timer that calls `onFire` when the delay elapses. The timer does NOT
 * check generation drift — delayed work survives channel noise.
 */
export declare function scheduleWorkContinuation(params: {
    signal: ContinuationSignal & {
        kind: "work";
    };
    chainState: ChainState;
    config: ContinuationRuntimeConfig;
    sessionKey: string;
    onFire: (nextChainCount: number, chainStartedAt: number, accumulatedTokens: number, workReason?: string) => void;
    workReason?: string;
}): ScheduleWorkResult;
/**
 * Schedule a DELEGATE continuation — either immediate or delayed.
 *
 * Immediate delegates are dispatched right away (the caller handles spawn).
 * Delayed delegates are parked as reservations and armed with a timer.
 */
export declare function scheduleDelegateContinuation(params: {
    signal: ContinuationSignal & {
        kind: "delegate";
    };
    chainState: ChainState;
    config: ContinuationRuntimeConfig;
    sessionKey: string;
    onImmediateSpawn: (plannedHop: number, task: string, options?: {
        silent?: boolean;
        silentWake?: boolean;
        startedAt?: number;
    }) => Promise<boolean>;
    onDelayedSpawn: (reservation: {
        plannedHop: number;
        task: string;
        silent?: boolean;
        silentWake?: boolean;
        startedAt?: number;
    }) => Promise<boolean>;
}): ScheduleDelegateResult;
