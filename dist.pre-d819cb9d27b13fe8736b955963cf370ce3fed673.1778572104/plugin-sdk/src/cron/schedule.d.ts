import type { CronSchedule } from "./types.js";
export declare function coerceFiniteScheduleNumber(value: unknown): number | undefined;
export declare function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined;
export declare function computePreviousRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined;
export declare function clearCronScheduleCacheForTest(): void;
export declare function getCronScheduleCacheSizeForTest(): number;
export declare function getCronScheduleCacheMaxForTest(): number;
export declare function hasCronInCacheForTest(expr: string, tz: string): boolean;
