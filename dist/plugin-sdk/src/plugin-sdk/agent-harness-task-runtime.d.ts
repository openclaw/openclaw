import { deliverSubagentAnnouncement } from "../agents/subagent-announce-delivery.js";
import { type AgentHarnessTaskRuntimeScope } from "../tasks/agent-harness-task-runtime-scope.js";
import { createRunningTaskRun, finalizeTaskRunByRunId, recordTaskRunProgressByRunId, setDetachedTaskDeliveryStatusByRunId } from "../tasks/detached-task-runtime.js";
import { type TaskRecord } from "../tasks/runtime-internal.js";
export type { TaskRecord as AgentHarnessTaskRecord };
export type { AgentHarnessTaskRuntimeScope };
type AgentHarnessTaskRuntimeId = Parameters<typeof createRunningTaskRun>[0]["runtime"];
type CreateRunningTaskRunParams = Parameters<typeof createRunningTaskRun>[0];
type RecordTaskRunProgressParams = Parameters<typeof recordTaskRunProgressByRunId>[0];
type FinalizeTaskRunParams = Parameters<typeof finalizeTaskRunByRunId>[0];
type SetDeliveryStatusParams = Parameters<typeof setDetachedTaskDeliveryStatusByRunId>[0];
export type AgentHarnessTaskRuntimeScopeParams = {
    runtime: AgentHarnessTaskRuntimeId;
    scope: AgentHarnessTaskRuntimeScope;
    taskKind?: string;
    runIdPrefix?: string;
};
export type AgentHarnessScopedCreateRunningTaskRunParams = Omit<CreateRunningTaskRunParams, "runtime" | "taskKind" | "requesterSessionKey" | "ownerKey" | "scopeKind"> & {
    runId: string;
};
export type AgentHarnessScopedRecordTaskRunProgressParams = Omit<RecordTaskRunProgressParams, "runtime" | "sessionKey">;
export type AgentHarnessScopedFinalizeTaskRunParams = Omit<FinalizeTaskRunParams, "runtime" | "sessionKey">;
export type AgentHarnessScopedSetDeliveryStatusParams = Omit<SetDeliveryStatusParams, "runtime" | "sessionKey">;
export type AgentHarnessTaskRuntime = {
    createRunningTaskRun(params: AgentHarnessScopedCreateRunningTaskRunParams): TaskRecord;
    recordTaskRunProgressByRunId(params: AgentHarnessScopedRecordTaskRunProgressParams): TaskRecord[];
    finalizeTaskRunByRunId(params: AgentHarnessScopedFinalizeTaskRunParams): TaskRecord[];
    setDetachedTaskDeliveryStatusByRunId(params: AgentHarnessScopedSetDeliveryStatusParams): TaskRecord[];
    listTaskRecords(): TaskRecord[];
};
export type AgentHarnessCompletionStatus = "succeeded" | "failed" | "cancelled";
export type AgentHarnessCompletionDelivery = Awaited<ReturnType<typeof deliverSubagentAnnouncement>>;
export declare function createAgentHarnessTaskRuntime(params: AgentHarnessTaskRuntimeScopeParams): AgentHarnessTaskRuntime;
export declare function deliverAgentHarnessTaskCompletion(params: {
    scope: AgentHarnessTaskRuntimeScope;
    childSessionKey: string;
    childSessionId: string;
    announceId: string;
    status: AgentHarnessCompletionStatus;
    statusLabel?: string;
    result: string;
    taskLabel?: string;
    announceType?: string;
    replyInstruction?: string;
    signal?: AbortSignal;
}): Promise<AgentHarnessCompletionDelivery>;
export declare function isDurableAgentHarnessCompletionDelivery(delivery: AgentHarnessCompletionDelivery): boolean;
