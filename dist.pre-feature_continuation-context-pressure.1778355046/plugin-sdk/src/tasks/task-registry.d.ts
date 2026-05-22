import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import type { TaskRegistryControlRuntime } from "./task-registry-control.types.js";
import type { TaskDeliveryState, TaskDeliveryStatus, TaskEventRecord, TaskNotifyPolicy, TaskRecord, TaskRegistrySummary, TaskRegistrySnapshot, TaskRuntime, TaskScopeKind, TaskStatus, TaskTerminalOutcome } from "./task-registry.types.js";
type TaskRegistryDeliveryRuntime = Pick<typeof import("./task-registry-delivery-runtime.js"), "sendMessage">;
export type ParentFlowLinkErrorCode = "scope_kind_not_session" | "parent_flow_not_found" | "owner_key_mismatch" | "cancel_requested" | "terminal";
export declare class ParentFlowLinkError extends Error {
    readonly code: ParentFlowLinkErrorCode;
    readonly details?: {
        flowId?: string;
        status?: TaskFlowRecord["status"];
    } | undefined;
    constructor(code: ParentFlowLinkErrorCode, message: string, details?: {
        flowId?: string;
        status?: TaskFlowRecord["status"];
    } | undefined);
}
export declare function isParentFlowLinkError(error: unknown): error is ParentFlowLinkError;
export declare function ensureTaskRegistryReady(): void;
export declare function reloadTaskRegistryFromStore(): void;
export declare function maybeDeliverTaskTerminalUpdate(taskId: string): Promise<TaskRecord | null>;
export declare function maybeDeliverTaskStateChangeUpdate(taskId: string, latestEvent?: TaskEventRecord): Promise<TaskRecord | null>;
export declare function setTaskProgressById(params: {
    taskId: string;
    progressSummary?: string | null;
    lastEventAt?: number;
}): TaskRecord | null;
export declare function setTaskTimingById(params: {
    taskId: string;
    startedAt?: number;
    endedAt?: number;
    lastEventAt?: number;
}): TaskRecord | null;
export declare function setTaskCleanupAfterById(params: {
    taskId: string;
    cleanupAfter: number;
}): TaskRecord | null;
export declare function markTaskTerminalById(params: {
    taskId: string;
    status: Extract<TaskStatus, "succeeded" | "failed" | "timed_out" | "cancelled">;
    endedAt: number;
    lastEventAt?: number;
    error?: string;
    terminalSummary?: string | null;
    terminalOutcome?: TaskTerminalOutcome | null;
}): TaskRecord | null;
export declare function markTaskLostById(params: {
    taskId: string;
    endedAt: number;
    lastEventAt?: number;
    error?: string;
    cleanupAfter?: number;
}): TaskRecord | null;
export declare function createTaskRecord(params: {
    runtime: TaskRuntime;
    taskKind?: string;
    sourceId?: string;
    requesterSessionKey?: string;
    ownerKey?: string;
    scopeKind?: TaskScopeKind;
    requesterOrigin?: TaskDeliveryState["requesterOrigin"];
    childSessionKey?: string;
    parentFlowId?: string;
    parentTaskId?: string;
    agentId?: string;
    runId?: string;
    label?: string;
    task: string;
    preferMetadata?: boolean;
    status?: TaskStatus;
    deliveryStatus?: TaskDeliveryStatus;
    notifyPolicy?: TaskNotifyPolicy;
    startedAt?: number;
    lastEventAt?: number;
    cleanupAfter?: number;
    progressSummary?: string | null;
    terminalSummary?: string | null;
    terminalOutcome?: TaskTerminalOutcome | null;
}): TaskRecord;
export declare function markTaskRunningByRunId(params: {
    runId: string;
    runtime?: TaskRuntime;
    sessionKey?: string;
    startedAt?: number;
    lastEventAt?: number;
    progressSummary?: string | null;
    eventSummary?: string | null;
}): TaskRecord[];
export declare function recordTaskProgressByRunId(params: {
    runId: string;
    runtime?: TaskRuntime;
    sessionKey?: string;
    lastEventAt?: number;
    progressSummary?: string | null;
    eventSummary?: string | null;
}): TaskRecord[];
export declare function markTaskTerminalByRunId(params: {
    runId: string;
    runtime?: TaskRuntime;
    sessionKey?: string;
    status: Extract<TaskStatus, "succeeded" | "failed" | "timed_out" | "cancelled">;
    startedAt?: number;
    endedAt: number;
    lastEventAt?: number;
    error?: string;
    progressSummary?: string | null;
    terminalSummary?: string | null;
    terminalOutcome?: TaskTerminalOutcome | null;
}): TaskRecord[];
export declare function finalizeTaskRunByRunId(params: {
    runId: string;
    runtime?: TaskRuntime;
    sessionKey?: string;
    status: Extract<TaskStatus, "succeeded" | "failed" | "timed_out" | "cancelled">;
    startedAt?: number;
    endedAt: number;
    lastEventAt?: number;
    error?: string;
    progressSummary?: string | null;
    terminalSummary?: string | null;
    terminalOutcome?: TaskTerminalOutcome | null;
}): TaskRecord[];
export declare function setTaskRunDeliveryStatusByRunId(params: {
    runId: string;
    runtime?: TaskRuntime;
    sessionKey?: string;
    deliveryStatus: TaskDeliveryStatus;
    error?: string;
}): TaskRecord[];
export declare function updateTaskNotifyPolicyById(params: {
    taskId: string;
    notifyPolicy: TaskNotifyPolicy;
}): TaskRecord | null;
export declare function linkTaskToFlowById(params: {
    taskId: string;
    flowId: string;
}): TaskRecord | null;
export declare function cancelTaskById(params: {
    cfg: OpenClawConfig;
    taskId: string;
}): Promise<{
    found: boolean;
    cancelled: boolean;
    reason?: string;
    task?: TaskRecord;
}>;
export declare function listTaskRecords(): TaskRecord[];
export declare function hasActiveTaskForChildSessionKey(params: {
    sessionKey: string;
    excludeTaskId?: string;
}): boolean;
export declare function getTaskRegistrySummary(): TaskRegistrySummary;
export declare function getTaskRegistrySnapshot(): TaskRegistrySnapshot;
export declare function getTaskById(taskId: string): TaskRecord | undefined;
export declare function findTaskByRunId(runId: string): TaskRecord | undefined;
export declare function findLatestTaskForSessionKey(sessionKey: string): TaskRecord | undefined;
export declare function listTasksForSessionKey(sessionKey: string): TaskRecord[];
export declare function listTasksForAgentId(agentId: string): TaskRecord[];
export declare function findLatestTaskForOwnerKey(ownerKey: string): TaskRecord | undefined;
export declare function findLatestTaskForFlowId(flowId: string): TaskRecord | undefined;
export declare function listTasksForOwnerKey(ownerKey: string): TaskRecord[];
export declare function listTasksForFlowId(flowId: string): TaskRecord[];
export declare function findLatestTaskForRelatedSessionKey(sessionKey: string): TaskRecord | undefined;
export declare function listTasksForRelatedSessionKey(sessionKey: string): TaskRecord[];
export declare function resolveTaskForLookupToken(token: string): TaskRecord | undefined;
export declare function deleteTaskRecordById(taskId: string): boolean;
export declare function resetTaskRegistryForTests(opts?: {
    persist?: boolean;
}): void;
export declare function resetTaskRegistryDeliveryRuntimeForTests(): void;
export declare function setTaskRegistryDeliveryRuntimeForTests(runtime: TaskRegistryDeliveryRuntime): void;
export declare function resetTaskRegistryControlRuntimeForTests(): void;
export declare function setTaskRegistryControlRuntimeForTests(runtime: TaskRegistryControlRuntime): void;
export {};
