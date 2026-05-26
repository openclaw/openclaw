import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
export declare function listRunsForRequesterFromRuns(runs: Map<string, SubagentRunRecord>, requesterSessionKey: string, options?: {
    requesterRunId?: string;
}): SubagentRunRecord[];
export declare function listRunsForControllerFromRuns(runs: Map<string, SubagentRunRecord>, controllerSessionKey: string): SubagentRunRecord[];
export type SubagentRunReadIndex = {
    getDisplaySubagentRun(childSessionKey: string): SubagentRunRecord | null;
    countActiveDescendantRuns(rootSessionKey: string): number;
    runsByControllerSessionKey: ReadonlyMap<string, readonly SubagentRunRecord[]>;
};
export declare function buildSubagentRunReadIndexFromRuns(params: {
    runs: Map<string, SubagentRunRecord>;
    inMemoryRuns?: Iterable<SubagentRunRecord>;
    now?: number;
}): SubagentRunReadIndex;
export declare function isSubagentSessionRunActiveFromRuns(runs: Map<string, SubagentRunRecord>, childSessionKey: string): boolean;
export declare function getSubagentRunByChildSessionKeyFromRuns(runs: Map<string, SubagentRunRecord>, childSessionKey: string): SubagentRunRecord | null;
export declare function resolveRequesterForChildSessionFromRuns(runs: Map<string, SubagentRunRecord>, childSessionKey: string): {
    requesterSessionKey: string;
    requesterOrigin?: DeliveryContext;
} | null;
export declare function shouldIgnorePostCompletionAnnounceForSessionFromRuns(runs: Map<string, SubagentRunRecord>, childSessionKey: string): boolean;
export declare function countActiveRunsForSessionFromRuns(runs: Map<string, SubagentRunRecord>, controllerSessionKey: string): number;
export declare function countActiveDescendantRunsFromRuns(runs: Map<string, SubagentRunRecord>, rootSessionKey: string): number;
export declare function countPendingDescendantRunsFromRuns(runs: Map<string, SubagentRunRecord>, rootSessionKey: string): number;
export declare function countPendingDescendantRunsExcludingRunFromRuns(runs: Map<string, SubagentRunRecord>, rootSessionKey: string, excludeRunId: string): number;
export declare function listDescendantRunsForRequesterFromRuns(runs: Map<string, SubagentRunRecord>, rootSessionKey: string): SubagentRunRecord[];
