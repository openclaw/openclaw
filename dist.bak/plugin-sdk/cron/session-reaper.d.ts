/**
 * Cron session reaper — prunes completed isolated cron run sessions
 * from the session store after a configurable retention period.
 *
 * Pattern: sessions keyed as `...:cron:<jobId>:run:<uuid>` are ephemeral
 * run records. The base session (`...:cron:<jobId>`) is kept as-is.
 */
import type { CronConfig } from "../config/types.cron.js";
import type { Logger } from "./service/state.js";
export declare function resolveRetentionMs(cronConfig?: CronConfig): number | null;
export type ReaperResult = {
    swept: boolean;
    pruned: number;
};
/**
 * Sweep the session store and prune expired cron run sessions.
 * Designed to be called from the cron timer tick — self-throttles via
 * MIN_SWEEP_INTERVAL_MS to avoid excessive I/O.
 *
 * Lock ordering: this function acquires the session-store file lock via
 * `updateSessionStore`. It must be called OUTSIDE of the cron service's
 * own `locked()` section to avoid lock-order inversions. The cron timer
 * calls this after all `locked()` sections have been released.
 */
export declare function sweepCronRunSessions(params: {
    cronConfig?: CronConfig;
    /** Resolved path to sessions.json — required. */
    sessionStorePath: string;
    nowMs?: number;
    log: Logger;
    /** Override for testing — skips the min-interval throttle. */
    force?: boolean;
}): Promise<ReaperResult>;
/** Reset the throttle timer (for tests). */
export declare function resetReaperThrottle(): void;
