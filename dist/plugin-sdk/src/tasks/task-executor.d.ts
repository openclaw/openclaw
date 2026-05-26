import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DetachedRunningTaskCreateParams, DetachedTaskCreateParams, DetachedTaskFinalizeParams } from "./detached-task-runtime-contract.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import type { TaskDeliveryState, TaskDeliveryStatus, TaskNotifyPolicy, TaskRecord, TaskRegistrySummary, TaskRuntime, TaskStatus, TaskTerminalOutcome } from "./task-registry.types.js";
type TaskRunCreateParams = DetachedTaskCreateParams;
type RunningTaskRunCreateParams = DetachedRunningTaskCreateParams;
export declare function createQueuedTaskRun(params: TaskRunCreateParams): TaskRecord;
export declare function getFlowTaskSummary(flowId: string): TaskRegistrySummary;
export declare function createRunningTaskRun(params: RunningTaskRunCreateParams): TaskRecord;
type RunTaskInFlowParams = {
    flowId: string;
    runtime: TaskRuntime;
    sourceId?: string;
    childSessionKey?: string;
    parentTaskId?: string;
    agentId?: string;
    runId?: string;
    label?: string;
    task: string;
    notifyPolicy?: TaskNotifyPolicy;
    deliveryStatus?: TaskDeliveryStatus;
    preferMetadata?: boolean;
    status?: "queued" | "running";
    startedAt?: number;
    lastEventAt?: number;
    progressSummary?: string | null;
};
export declare function startTaskRunByRunId(params: {
    runId: string;
    runtime?: TaskRuntime;
    sessionKey?: string;
    startedAt?: number;
    lastEventAt?: number;
    progressSummary?: string | null;
    eventSummary?: string | null;
}): TaskRecord[];
export declare function recordTaskRunProgressByRunId(params: {
    runId: string;
    runtime?: TaskRuntime;
    sessionKey?: string;
    lastEventAt?: number;
    progressSummary?: string | null;
    eventSummary?: string | null;
}): TaskRecord[];
export declare function completeTaskRunByRunId(params: {
    runId: string;
    runtime?: TaskRuntime;
    sessionKey?: string;
    endedAt: number;
    lastEventAt?: number;
    progressSummary?: string | null;
    terminalSummary?: string | null;
    terminalOutcome?: TaskTerminalOutcome | null;
}): TaskRecord[];
export declare function finalizeTaskRunByRunId(params: DetachedTaskFinalizeParams): TaskRecord[];
export declare function failTaskRunByRunId(params: {
    runId: string;
    runtime?: TaskRuntime;
    sessionKey?: string;
    status?: Extract<TaskStatus, "failed" | "timed_out" | "cancelled">;
    endedAt: number;
    lastEventAt?: number;
    error?: string;
    progressSummary?: string | null;
    terminalSummary?: string | null;
}): TaskRecord[];
export declare function markTaskRunLostById(params: {
    taskId: string;
    endedAt: number;
    lastEventAt?: number;
    error?: string;
    cleanupAfter?: number;
}): TaskRecord | null;
export declare function setDetachedTaskDeliveryStatusByRunId(params: {
    runId: string;
    runtime?: TaskRuntime;
    sessionKey?: string;
    deliveryStatus: TaskDeliveryStatus;
    error?: string;
}): TaskRecord[];
type RetryBlockedFlowResult = {
    found: boolean;
    retried: boolean;
    reason?: string;
    previousTask?: TaskRecord;
    task?: TaskRecord;
};
type RetryBlockedFlowParams = {
    flowId: string;
    sourceId?: string;
    requesterOrigin?: TaskDeliveryState["requesterOrigin"];
    childSessionKey?: string;
    agentId?: string;
    runId?: string;
    label?: string;
    task?: string;
    preferMetadata?: boolean;
    notifyPolicy?: TaskNotifyPolicy;
    deliveryStatus?: TaskDeliveryStatus;
    status: "queued" | "running";
    startedAt?: number;
    lastEventAt?: number;
    progressSummary?: string | null;
};
export declare function retryBlockedFlowAsQueuedTaskRun(params: Omit<RetryBlockedFlowParams, "status" | "startedAt" | "lastEventAt" | "progressSummary">): RetryBlockedFlowResult;
export declare function retryBlockedFlowAsRunningTaskRun(params: Omit<RetryBlockedFlowParams, "status">): RetryBlockedFlowResult;
type CancelFlowResult = {
    found: boolean;
    cancelled: boolean;
    reason?: string;
    flow?: TaskFlowRecord;
    tasks?: TaskRecord[];
};
type RunTaskInFlowResult = {
    found: boolean;
    created: boolean;
    reason?: string;
    flow?: TaskFlowRecord;
    task?: TaskRecord;
};
export declare function runTaskInFlow(params: RunTaskInFlowParams): RunTaskInFlowResult;
export declare function runTaskInFlowForOwner(params: RunTaskInFlowParams & {
    callerOwnerKey: string;
}): RunTaskInFlowResult;
export declare function cancelFlowById(params: {
    cfg: OpenClawConfig;
    flowId: string;
}): Promise<CancelFlowResult>;
export declare function cancelFlowByIdForOwner(params: {
    cfg: OpenClawConfig;
    flowId: string;
    callerOwnerKey: string;
}): Promise<CancelFlowResult>;
export declare function cancelDetachedTaskRunById(params: {
    cfg: OpenClawConfig;
    taskId: string;
}): Promise<import("./detached-task-runtime-contract.js").DetachedTaskCancelResult>;
export {};
