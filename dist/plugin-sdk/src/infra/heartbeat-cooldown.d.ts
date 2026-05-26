import type { HeartbeatWakeIntent, HeartbeatWakeSource } from "./heartbeat-wake.js";
export declare const DEFAULT_MIN_WAKE_SPACING_MS = 30000;
export declare const DEFAULT_FLOOD_WINDOW_MS = 60000;
export declare const DEFAULT_FLOOD_THRESHOLD = 5;
export type DeferDecision = {
    defer: false;
} | {
    defer: true;
    reason: "not-due" | "min-spacing" | "flood";
};
export type ShouldDeferInput = {
    /** Scheduler behavior requested by the wake producer. */
    intent: HeartbeatWakeIntent;
    /** Wake producer, used for diagnostics and future source-specific telemetry. */
    source?: HeartbeatWakeSource;
    /** Raw wake reason string for logs/model context. It does not drive scheduling policy. */
    reason: string | undefined;
    /** Current monotonic-ish wall clock. Pass `Date.now()`. */
    now: number;
    /** When this agent's next interval-tick run is due. */
    nextDueMs: number;
    /** When this agent last *started* a run, if known. */
    lastRunStartedAtMs?: number;
    /** Recent wake timestamps for flood detection. */
    recentRunStarts?: readonly number[];
    /** Override the minimum spacing floor. */
    minSpacingMs?: number;
    /** Override the flood-window length. */
    floodWindowMs?: number;
    /** Override the flood-window threshold. */
    floodThreshold?: number;
};
/**
 * Decide whether an incoming wake should be deferred.
 *
 * The decision matrix:
 *
 * | Wake intent   | First wake (no prior run) | Subsequent wakes                       |
 * |---------------|----------------------------|-----------------------------------------|
 * | manual        | Run                        | Run (never deferred)                    |
 * | immediate     | Run                        | Run (never deferred, except flood)      |
 * | scheduled     | Defer if now < nextDueMs   | Defer if now < nextDueMs                |
 * | event         | Run (bootstrap responsive) | Defer if now < nextDueMs OR within floor |
 *
 * Immediate is for documented wake-now delivery paths such as `openclaw system
 * event --mode now`, task completion follow-ups, cron `--wake now`, and
 * `/hooks/wake mode=now`. Event is for external/system notifications such as
 * background exec exits, node notification changes, hook/cron next-heartbeat
 * handoffs, ACP spawn stream updates, and retry wakes.
 *
 * Additional gates layered on top of the reason matrix:
 *
 *   1. **Minimum spacing floor** (`min-spacing`): even if `nextDueMs` has been
 *      passed, defer if a run started within the last `minSpacingMs`. Catches
 *      the race where a second wake arrives between `runOnce` returning and
 *      `advanceAgentSchedule` updating `nextDueMs`.
 *   2. **Flood guard** (`flood`): if `recentRunStarts` shows ≥ `floodThreshold`
 *      runs within `floodWindowMs`, defer regardless of reason (except
 *      `manual`-class immediate intent). Caller should also emit a single
 *      warning log when this fires.
 */
export declare function shouldDeferWake(input: ShouldDeferInput): DeferDecision;
/**
 * Append a run-start timestamp to a bounded recent-runs buffer. Caller passes
 * the previous buffer; this returns a new (mutated) buffer with the entry
 * appended and trimmed to `floodThreshold + 1` entries (only the newest matter
 * for flood detection).
 */
export declare function recordRunStart(buffer: number[], ts: number, floodThreshold?: number): number[];
