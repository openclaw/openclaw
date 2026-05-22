import type { TaskNotifyPolicy, TaskRecord } from "./task-registry.types.js";
export declare function getTaskByIdForOwner(params: {
    taskId: string;
    callerOwnerKey: string;
}): TaskRecord | undefined;
export declare function findTaskByRunIdForOwner(params: {
    runId: string;
    callerOwnerKey: string;
}): TaskRecord | undefined;
/** Update an owner-visible task's notification policy. */
export declare function updateTaskNotifyPolicyForOwner(params: {
    taskId: string;
    callerOwnerKey: string;
    notifyPolicy: TaskNotifyPolicy;
}): TaskRecord | null;
/** Mark an owner-visible task as cancelled with a caller-provided summary. */
export declare function cancelTaskByIdForOwner(params: {
    taskId: string;
    callerOwnerKey: string;
    endedAt: number;
    terminalSummary?: string | null;
}): TaskRecord | null;
export declare function listTasksForRelatedSessionKeyForOwner(params: {
    relatedSessionKey: string;
    callerOwnerKey: string;
}): TaskRecord[];
export declare function buildTaskStatusSnapshotForRelatedSessionKeyForOwner(params: {
    relatedSessionKey: string;
    callerOwnerKey: string;
}): import("./task-status.js").TaskStatusSnapshot;
export declare function findLatestTaskForRelatedSessionKeyForOwner(params: {
    relatedSessionKey: string;
    callerOwnerKey: string;
}): TaskRecord | undefined;
export declare function resolveTaskForLookupTokenForOwner(params: {
    token: string;
    callerOwnerKey: string;
}): TaskRecord | undefined;
