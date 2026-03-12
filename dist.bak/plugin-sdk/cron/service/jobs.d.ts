import type { CronJob, CronJobCreate, CronJobPatch } from "../types.js";
import type { CronServiceState } from "./state.js";
export declare function assertSupportedJobSpec(job: Pick<CronJob, "sessionTarget" | "payload">): void;
export declare function findJobOrThrow(state: CronServiceState, id: string): CronJob;
export declare function computeJobNextRunAtMs(job: CronJob, nowMs: number): number | undefined;
export declare function recomputeNextRuns(state: CronServiceState): boolean;
/**
 * Maintenance-only version of recomputeNextRuns that handles disabled jobs
 * and stuck markers, but does NOT recompute nextRunAtMs for enabled jobs
 * with existing values. Used during timer ticks when no due jobs were found
 * to prevent silently advancing past-due nextRunAtMs values without execution
 * (see #13992).
 */
export declare function recomputeNextRunsForMaintenance(state: CronServiceState): boolean;
export declare function nextWakeAtMs(state: CronServiceState): number | undefined;
export declare function createJob(state: CronServiceState, input: CronJobCreate): CronJob;
export declare function applyJobPatch(job: CronJob, patch: CronJobPatch): void;
export declare function isJobDue(job: CronJob, nowMs: number, opts: {
    forced: boolean;
}): boolean;
export declare function resolveJobPayloadTextForMain(job: CronJob): string | undefined;
