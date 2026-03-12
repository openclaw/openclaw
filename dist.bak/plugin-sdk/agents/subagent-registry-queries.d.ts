import type { DeliveryContext } from "../utils/delivery-context.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
export declare function findRunIdsByChildSessionKeyFromRuns(runs: Map<string, SubagentRunRecord>, childSessionKey: string): string[];
export declare function listRunsForRequesterFromRuns(runs: Map<string, SubagentRunRecord>, requesterSessionKey: string): SubagentRunRecord[];
export declare function resolveRequesterForChildSessionFromRuns(runs: Map<string, SubagentRunRecord>, childSessionKey: string): {
    requesterSessionKey: string;
    requesterOrigin?: DeliveryContext;
} | null;
export declare function countActiveRunsForSessionFromRuns(runs: Map<string, SubagentRunRecord>, requesterSessionKey: string): number;
export declare function countActiveDescendantRunsFromRuns(runs: Map<string, SubagentRunRecord>, rootSessionKey: string): number;
export declare function listDescendantRunsForRequesterFromRuns(runs: Map<string, SubagentRunRecord>, rootSessionKey: string): SubagentRunRecord[];
