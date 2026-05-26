import type { CronJob } from "./types.js";
export declare function tryCronScheduleIdentity(job: {
    schedule?: unknown;
    enabled?: unknown;
} & Record<string, unknown>): string | undefined;
export declare function cronSchedulingInputsEqual(previous: Pick<CronJob, "schedule"> & {
    enabled?: unknown;
}, next: Pick<CronJob, "schedule"> & {
    enabled?: unknown;
}): boolean;
