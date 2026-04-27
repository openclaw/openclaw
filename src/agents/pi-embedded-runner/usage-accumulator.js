import { normalizeUsage } from "../usage.js";
export const createUsageAccumulator = () => ({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    lastInput: 0,
    lastOutput: 0,
    lastCacheRead: 0,
    lastCacheWrite: 0,
    lastTotal: 0,
});
const hasUsageValues = (usage) => !!usage &&
    [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.total].some((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
export const mergeUsageIntoAccumulator = (target, usage) => {
    if (!hasUsageValues(usage)) {
        return;
    }
    const callTotal = usage.total ??
        (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    target.input += usage.input ?? 0;
    target.output += usage.output ?? 0;
    target.cacheRead += usage.cacheRead ?? 0;
    target.cacheWrite += usage.cacheWrite ?? 0;
    target.total += callTotal;
    target.lastInput = usage.input ?? 0;
    target.lastOutput = usage.output ?? 0;
    target.lastCacheRead = usage.cacheRead ?? 0;
    target.lastCacheWrite = usage.cacheWrite ?? 0;
    target.lastTotal = callTotal;
};
export const toNormalizedUsage = (usage) => {
    const hasUsage = usage.input > 0 ||
        usage.output > 0 ||
        usage.cacheRead > 0 ||
        usage.cacheWrite > 0 ||
        usage.total > 0;
    if (!hasUsage) {
        return undefined;
    }
    return {
        input: usage.input || undefined,
        output: usage.output || undefined,
        cacheRead: usage.cacheRead || undefined,
        cacheWrite: usage.cacheWrite || undefined,
        total: usage.total || undefined,
    };
};
export const toLastCallUsage = (usage) => {
    const hasUsage = usage.lastInput > 0 ||
        usage.lastOutput > 0 ||
        usage.lastCacheRead > 0 ||
        usage.lastCacheWrite > 0 ||
        usage.lastTotal > 0;
    if (!hasUsage) {
        return undefined;
    }
    return {
        input: usage.lastInput || undefined,
        output: usage.lastOutput || undefined,
        cacheRead: usage.lastCacheRead || undefined,
        cacheWrite: usage.lastCacheWrite || undefined,
        total: usage.lastTotal || undefined,
    };
};
export const resolveLastCallUsage = (rawUsage, usageAccumulator) => normalizeUsage(rawUsage) ?? toLastCallUsage(usageAccumulator);
