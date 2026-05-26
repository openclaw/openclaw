import { t as DeliveryContext } from "./delivery-context.types-DsJXWtUi.js";
import { r as TaskNotifyPolicy } from "./task-registry.types-CicKx6sv.js";

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
export { TaskFlowRecord as n, TaskFlowStatus as r, JsonValue as t };