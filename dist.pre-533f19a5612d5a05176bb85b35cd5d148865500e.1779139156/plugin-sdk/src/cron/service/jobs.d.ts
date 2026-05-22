import type { CronJob, CronJobCreate, CronJobPatch } from "../types.js";
import type { CronServiceState } from "./state.js";
export declare const DEFAULT_ERROR_BACKOFF_SCHEDULE_MS: number[];
export declare function hasScheduledNextRunAtMs(value: unknown): value is number;
export declare function errorBackoffMs(consecutiveErrors: number, scheduleMs?: number[]): number;
export declare function assertSupportedJobSpec(job: Pick<CronJob, "sessionTarget" | "payload">): void;
export declare function findJobOrThrow(state: CronServiceState, id: string): CronJob;
export declare function isJobEnabled(job: Pick<CronJob, "enabled">): boolean;
export declare function computeJobNextRunAtMs(job: CronJob, nowMs: number): number | undefined;
export declare function computeJobPreviousRunAtMs(job: CronJob, nowMs: number): number | undefined;
export declare function recordScheduleComputeError(params: {
    state: CronServiceState;
    job: CronJob;
    err: unknown;
}): boolean;
export declare function recomputeNextRuns(state: CronServiceState): boolean;
/**
 * Maintenance-only version of recomputeNextRuns that handles disabled jobs
 * and stuck markers, but does NOT recompute nextRunAtMs for enabled jobs
 * with existing values. Used during timer ticks when no due jobs were found
 * to prevent silently advancing past-due nextRunAtMs values without execution
 * (see #13992).
 */
export declare function recomputeNextRunsForMaintenance(state: CronServiceState, opts?: {
    recomputeExpired?: boolean;
    nowMs?: number;
    repairFutureCronNextRunAtMs?: boolean;
}): boolean;
export declare function nextWakeAtMs(state: CronServiceState): number | undefined;
export declare function createJob(state: CronServiceState, input: CronJobCreate): CronJob;
export declare function applyJobPatch(job: CronJob, patch: CronJobPatch, opts?: {
    defaultAgentId?: string;
}): void;
export declare function isJobDue(job: CronJob, nowMs: number, opts: {
    forced: boolean;
}): boolean;
export declare function resolveJobPayloadTextForMain(job: CronJob): string | undefined;
