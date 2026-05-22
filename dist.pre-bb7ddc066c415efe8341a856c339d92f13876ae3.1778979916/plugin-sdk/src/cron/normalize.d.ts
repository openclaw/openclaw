import type { CronJobCreate, CronJobPatch } from "./types.js";
type UnknownRecord = Record<string, unknown>;
type NormalizeOptions = {
    applyDefaults?: boolean;
    /** Session context for resolving "current" sessionTarget or auto-binding when not specified */
    sessionContext?: {
        sessionKey?: string;
    };
};
export declare function normalizeCronJobInput(raw: unknown, options?: NormalizeOptions): UnknownRecord | null;
export declare function normalizeCronJobCreate(raw: unknown, options?: Omit<NormalizeOptions, "applyDefaults">): CronJobCreate | null;
export declare function normalizeCronJobPatch(raw: unknown, options?: NormalizeOptions): CronJobPatch | null;
export {};
