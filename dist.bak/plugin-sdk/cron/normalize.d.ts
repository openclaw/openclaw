import type { CronJobCreate, CronJobPatch } from "./types.js";
type UnknownRecord = Record<string, unknown>;
type NormalizeOptions = {
    applyDefaults?: boolean;
};
export declare function normalizeCronJobInput(raw: unknown, options?: NormalizeOptions): UnknownRecord | null;
export declare function normalizeCronJobCreate(raw: unknown, options?: NormalizeOptions): CronJobCreate | null;
export declare function normalizeCronJobPatch(raw: unknown, options?: NormalizeOptions): CronJobPatch | null;
export {};
