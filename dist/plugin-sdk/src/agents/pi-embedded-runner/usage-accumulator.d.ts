import { type NormalizedUsage, type UsageLike } from "../usage.js";
export type UsageAccumulator = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    /** Exact usage snapshot from the most recent API call. */
    lastInput: number;
    lastOutput: number;
    lastCacheRead: number;
    lastCacheWrite: number;
    lastTotal: number;
};
export declare const createUsageAccumulator: () => UsageAccumulator;
type MaybeUsage = NormalizedUsage | undefined;
export declare const mergeUsageIntoAccumulator: (target: UsageAccumulator, usage: MaybeUsage) => void;
export declare const toNormalizedUsage: (usage: UsageAccumulator) => NormalizedUsage | undefined;
export declare const toLastCallUsage: (usage: UsageAccumulator) => NormalizedUsage | undefined;
export declare const resolveLastCallUsage: (rawUsage: UsageLike | null | undefined, usageAccumulator: UsageAccumulator) => NormalizedUsage | undefined;
export {};
