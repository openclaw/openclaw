import type { CronSchedule } from "./types.js";
export declare function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined;
