import { type NormalizedUsage } from "../../agents/usage.js";
import { incrementCompactionCount } from "./session-updates.js";
import { persistSessionUsageUpdate } from "./session-usage.js";
type PersistRunSessionUsageParams = Parameters<typeof persistSessionUsageUpdate>[0];
type IncrementRunCompactionCountParams = Omit<Parameters<typeof incrementCompactionCount>[0], "tokensAfter"> & {
    lastCallUsage?: NormalizedUsage;
    contextTokensUsed?: number;
};
export declare function persistRunSessionUsage(params: PersistRunSessionUsageParams): Promise<void>;
export declare function incrementRunCompactionCount(params: IncrementRunCompactionCountParams): Promise<number | undefined>;
export {};
