import { i as TaskRecord } from "../task-registry.types-DPk1C2Tz.js";
import { n as DetachedTaskLifecycleRuntime, t as DetachedTaskFinalizeParams } from "../detached-task-runtime-contract-2CpFK91Z.js";

//#region src/tasks/detached-task-runtime.d.ts
declare function createRunningTaskRun(...args: Parameters<DetachedTaskLifecycleRuntime["createRunningTaskRun"]>): ReturnType<DetachedTaskLifecycleRuntime["createRunningTaskRun"]>;
declare function recordTaskRunProgressByRunId(...args: Parameters<DetachedTaskLifecycleRuntime["recordTaskRunProgressByRunId"]>): ReturnType<DetachedTaskLifecycleRuntime["recordTaskRunProgressByRunId"]>;
declare function finalizeTaskRunByRunId(params: DetachedTaskFinalizeParams): TaskRecord[];
//#endregion
export { createRunningTaskRun, finalizeTaskRunByRunId, recordTaskRunProgressByRunId };