import { i as TaskRecord } from "./task-registry.types-CicKx6sv.js";
import { n as DetachedTaskLifecycleRuntime, t as DetachedTaskFinalizeParams } from "./detached-task-runtime-contract-UNgNSDOU.js";

//#region src/tasks/detached-task-runtime.d.ts
declare function createRunningTaskRun(...args: Parameters<DetachedTaskLifecycleRuntime["createRunningTaskRun"]>): ReturnType<DetachedTaskLifecycleRuntime["createRunningTaskRun"]>;
declare function recordTaskRunProgressByRunId(...args: Parameters<DetachedTaskLifecycleRuntime["recordTaskRunProgressByRunId"]>): ReturnType<DetachedTaskLifecycleRuntime["recordTaskRunProgressByRunId"]>;
declare function finalizeTaskRunByRunId(params: DetachedTaskFinalizeParams): TaskRecord[];
declare function setDetachedTaskDeliveryStatusByRunId(...args: Parameters<DetachedTaskLifecycleRuntime["setDetachedTaskDeliveryStatusByRunId"]>): ReturnType<DetachedTaskLifecycleRuntime["setDetachedTaskDeliveryStatusByRunId"]>;
//#endregion
export { setDetachedTaskDeliveryStatusByRunId as i, finalizeTaskRunByRunId as n, recordTaskRunProgressByRunId as r, createRunningTaskRun as t };