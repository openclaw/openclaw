import type { CronSchedule } from "./types.js";
type TimestampValidationError = {
    ok: false;
    message: string;
};
type TimestampValidationSuccess = {
    ok: true;
};
type TimestampValidationResult = TimestampValidationSuccess | TimestampValidationError;
/**
 * Validates at timestamps in cron schedules.
 * Rejects timestamps that are:
 * - More than 1 minute in the past
 * - More than 10 years in the future
 */
export declare function validateScheduleTimestamp(schedule: CronSchedule, nowMs?: number): TimestampValidationResult;
export {};
