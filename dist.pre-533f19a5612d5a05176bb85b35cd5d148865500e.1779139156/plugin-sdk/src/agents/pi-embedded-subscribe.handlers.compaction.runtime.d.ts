import type { CompactionCounterAttribution } from "./compaction-attribution.js";
export declare function reconcileSessionStoreCompactionCountAfterSuccess(params: {
    sessionKey?: string;
    agentId?: string;
    configStore?: string;
    observedCompactionCount: number;
    now?: number;
    attribution?: CompactionCounterAttribution;
}): Promise<number | undefined>;
