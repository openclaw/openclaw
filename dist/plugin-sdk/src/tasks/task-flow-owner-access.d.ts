import type { TaskFlowRecord } from "./task-flow-registry.types.js";
export declare function getTaskFlowByIdForOwner(params: {
    flowId: string;
    callerOwnerKey: string;
}): TaskFlowRecord | undefined;
export declare function listTaskFlowsForOwner(params: {
    callerOwnerKey: string;
}): TaskFlowRecord[];
export declare function findLatestTaskFlowForOwner(params: {
    callerOwnerKey: string;
}): TaskFlowRecord | undefined;
export declare function resolveTaskFlowForLookupTokenForOwner(params: {
    token: string;
    callerOwnerKey: string;
}): TaskFlowRecord | undefined;
