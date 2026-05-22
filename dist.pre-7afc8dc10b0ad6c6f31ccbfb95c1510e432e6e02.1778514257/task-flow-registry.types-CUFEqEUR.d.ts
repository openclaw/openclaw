import { t as DeliveryContext } from "./delivery-context.types-C7zJv-CH.js";

//#region src/tasks/task-registry.types.d.ts
type TaskRuntime = "subagent" | "acp" | "cli" | "cron";
type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "lost";
type TaskDeliveryStatus = "pending" | "delivered" | "session_queued" | "failed" | "parent_missing" | "not_applicable";
type TaskNotifyPolicy = "done_only" | "state_changes" | "silent";
type TaskTerminalOutcome = "succeeded" | "blocked";
type TaskScopeKind = "session" | "system";
type TaskStatusCounts = Record<TaskStatus, number>;
type TaskRuntimeCounts = Record<TaskRuntime, number>;
type TaskRegistrySummary = {
  total: number;
  active: number;
  terminal: number;
  failures: number;
  byStatus: TaskStatusCounts;
  byRuntime: TaskRuntimeCounts;
};
type TaskDeliveryState = {
  taskId: string;
  requesterOrigin?: DeliveryContext;
  lastNotifiedEventAt?: number;
};
type TaskRecord = {
  taskId: string;
  runtime: TaskRuntime;
  taskKind?: string;
  sourceId?: string;
  requesterSessionKey: string;
  ownerKey: string;
  scopeKind: TaskScopeKind;
  childSessionKey?: string;
  parentFlowId?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  task: string;
  status: TaskStatus;
  deliveryStatus: TaskDeliveryStatus;
  notifyPolicy: TaskNotifyPolicy;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
  cleanupAfter?: number;
  error?: string;
  progressSummary?: string;
  terminalSummary?: string;
  terminalOutcome?: TaskTerminalOutcome;
};
//#endregion
//#region src/tasks/task-flow-registry.types.d.ts
type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue;
};
type TaskFlowSyncMode = "task_mirrored" | "managed";
type TaskFlowStatus = "queued" | "running" | "waiting" | "blocked" | "succeeded" | "failed" | "cancelled" | "lost";
type TaskFlowRecord = {
  flowId: string;
  syncMode: TaskFlowSyncMode;
  ownerKey: string;
  /**
   * Originating continuation chain id.
   *
   * Set-once at create-time; subsequent hops within the same chain do NOT
   * update this column (UPDATE-on-hop deferred-by-design). Audit walks key
   * off this field as the chain-of-origin correlation id.
   */
  chainId?: string;
  requesterOrigin?: DeliveryContext;
  controllerId?: string;
  revision: number;
  status: TaskFlowStatus;
  notifyPolicy: TaskNotifyPolicy;
  goal: string;
  currentStep?: string;
  blockedTaskId?: string;
  blockedSummary?: string;
  stateJson?: JsonValue;
  waitJson?: JsonValue;
  cancelRequestedAt?: number;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
};
//#endregion
export { TaskDeliveryStatus as a, TaskRegistrySummary as c, TaskScopeKind as d, TaskStatus as f, TaskDeliveryState as i, TaskRuntime as l, TaskTerminalOutcome as m, TaskFlowRecord as n, TaskNotifyPolicy as o, TaskStatusCounts as p, TaskFlowStatus as r, TaskRecord as s, JsonValue as t, TaskRuntimeCounts as u };