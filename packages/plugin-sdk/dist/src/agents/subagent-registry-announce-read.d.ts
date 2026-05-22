import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
export declare function resolveRequesterForChildSession(childSessionKey: string): {
    requesterSessionKey: string;
    requesterOrigin?: DeliveryContext;
} | null;
export declare function isSubagentSessionRunActive(childSessionKey: string): boolean;
export declare function shouldIgnorePostCompletionAnnounceForSession(childSessionKey: string): boolean;
export declare function listSubagentRunsForRequester(requesterSessionKey: string, options?: {
    requesterRunId?: string;
}): SubagentRunRecord[];
export declare function countPendingDescendantRuns(rootSessionKey: string): number;
export declare function countPendingDescendantRunsExcludingRun(rootSessionKey: string, excludeRunId: string): number;
