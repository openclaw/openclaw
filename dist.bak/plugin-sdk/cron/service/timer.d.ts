import type { CronJob, CronRunOutcome, CronRunStatus, CronRunTelemetry } from "../types.js";
import type { CronEvent, CronServiceState } from "./state.js";
export { DEFAULT_JOB_TIMEOUT_MS } from "./timeout-policy.js";
export declare function executeJobCoreWithTimeout(state: CronServiceState, job: CronJob): Promise<Awaited<ReturnType<typeof executeJobCore>>>;
/**
 * Apply the result of a job execution to the job's state.
 * Handles consecutive error tracking, exponential backoff, one-shot disable,
 * and nextRunAtMs computation. Returns `true` if the job should be deleted.
 */
export declare function applyJobResult(state: CronServiceState, job: CronJob, result: {
    status: CronRunStatus;
    error?: string;
    delivered?: boolean;
    startedAt: number;
    endedAt: number;
}): boolean;
export declare function armTimer(state: CronServiceState): void;
export declare function onTimer(state: CronServiceState): Promise<void>;
export declare function runMissedJobs(state: CronServiceState, opts?: {
    skipJobIds?: ReadonlySet<string>;
}): Promise<void>;
export declare function runDueJobs(state: CronServiceState): Promise<void>;
export declare function executeJobCore(state: CronServiceState, job: CronJob, abortSignal?: AbortSignal): Promise<CronRunOutcome & CronRunTelemetry & {
    delivered?: boolean;
    deliveryAttempted?: boolean;
}>;
/**
 * Execute a job. This version is used by the `run` command and other
 * places that need the full execution with state updates.
 */
export declare function executeJob(state: CronServiceState, job: CronJob, _nowMs: number, _opts: {
    forced: boolean;
}): Promise<void>;
export declare function wake(state: CronServiceState, opts: {
    mode: "now" | "next-heartbeat";
    text: string;
}): {
    readonly ok: false;
} | {
    readonly ok: true;
};
export declare function stopTimer(state: CronServiceState): void;
export declare function emit(state: CronServiceState, evt: CronEvent): void;
