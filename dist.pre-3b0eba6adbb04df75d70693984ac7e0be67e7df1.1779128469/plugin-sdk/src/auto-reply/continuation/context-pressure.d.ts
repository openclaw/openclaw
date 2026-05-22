/**
 * Context-pressure awareness for the continuation system.
 *
 * Monitors session token usage relative to the context window and fires
 * system events when pressure bands are crossed. This gives the agent
 * advance warning to evacuate working state before compaction.
 *
 * Post-compaction: fires regardless of context level to inform the session
 * that compaction occurred. The session learns this cycle behaviorally.
 *
 * Band dedup: equality-based. The same band doesn't fire twice consecutively,
 * but a new band (including a lower band after compaction) always fires.
 *
 * First-fire is signalled by `lastFiredBand.has(sessionKey) === false`.
 * That avoids suppressing a first crossing when the computed band is 0.
 *
 * RFC: docs/design/continue-work-signal-v2.md §4.2
 */
import type { SessionEntry } from "../../config/sessions.js";
/** Pressure-band percentage returned by {@link resolveContextPressureBand}. */
export type PressureBand = number;
/**
 * Resolve which pressure band the current ratio falls into.
 * Returns 0 if below all bands.
 */
export declare function resolveContextPressureBand(ratio: number, threshold: number, earlyWarningBand?: number): PressureBand;
export interface CheckSessionContextPressureParams {
    sessionEntry: SessionEntry;
    sessionKey: string;
    contextPressureThreshold: number | undefined;
    contextWindowTokens: number;
    earlyWarningBand?: number;
    postCompaction?: boolean;
}
export interface CheckTokenContextPressureParams {
    sessionKey: string;
    totalTokens: number;
    contextWindow: number;
    threshold: number;
    earlyWarningBand?: number;
    postCompaction?: boolean;
}
export interface CheckContextPressureResult {
    fired: boolean;
    band: PressureBand;
}
/**
 * Check whether a context-pressure event should fire for the given session.
 *
 * Session-entry callers get the reply-pipeline result shape and event enqueueing.
 * Token callers get event text for lifecycle helpers that enqueue separately.
 */
export declare function checkContextPressure(params: CheckSessionContextPressureParams): CheckContextPressureResult;
export declare function checkContextPressure(params: CheckTokenContextPressureParams): string | null;
/**
 * Clear pressure dedup state for a session. Call after compaction completes
 * so the post-compaction lifecycle can fire fresh bands.
 */
export declare function clearContextPressureState(sessionKey: string): void;
export declare function resetContextPressureForTests(): void;
