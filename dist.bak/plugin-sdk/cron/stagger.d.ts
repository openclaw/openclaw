import type { CronSchedule } from "./types.js";
export declare const DEFAULT_TOP_OF_HOUR_STAGGER_MS: number;
export declare function isRecurringTopOfHourCronExpr(expr: string): boolean;
export declare function normalizeCronStaggerMs(raw: unknown): number | undefined;
export declare function resolveDefaultCronStaggerMs(expr: string): number | undefined;
export declare function resolveCronStaggerMs(schedule: Extract<CronSchedule, {
    kind: "cron";
}>): number;
