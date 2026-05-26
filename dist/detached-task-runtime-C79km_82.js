import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { r as getRegisteredDetachedTaskLifecycleRuntime } from "./detached-task-runtime-state-B0mh7AbV.js";
import { t as cancelTaskById } from "./task-registry-B9ljq8Nk.js";
import "./runtime-internal-2F71tA3B.js";
import { a as createQueuedTaskRun$1, c as finalizeTaskRunByRunId$1, f as setDetachedTaskDeliveryStatusByRunId$1, i as completeTaskRunByRunId$1, o as createRunningTaskRun$1, p as startTaskRunByRunId$1, s as failTaskRunByRunId$1, u as recordTaskRunProgressByRunId$1 } from "./task-executor-BGVJzIov.js";
//#region src/tasks/detached-task-runtime.ts
const log = createSubsystemLogger("tasks/detached-runtime");
const DETACHED_TASK_RECOVERY_WARN_MS = 5e3;
const DEFAULT_DETACHED_TASK_LIFECYCLE_RUNTIME = {
	createQueuedTaskRun: createQueuedTaskRun$1,
	createRunningTaskRun: createRunningTaskRun$1,
	startTaskRunByRunId: startTaskRunByRunId$1,
	recordTaskRunProgressByRunId: recordTaskRunProgressByRunId$1,
	finalizeTaskRunByRunId: finalizeTaskRunByRunId$1,
	completeTaskRunByRunId: completeTaskRunByRunId$1,
	failTaskRunByRunId: failTaskRunByRunId$1,
	setDetachedTaskDeliveryStatusByRunId: setDetachedTaskDeliveryStatusByRunId$1,
	cancelDetachedTaskRunById: cancelTaskById
};
function getDetachedTaskLifecycleRuntime() {
	return getRegisteredDetachedTaskLifecycleRuntime() ?? DEFAULT_DETACHED_TASK_LIFECYCLE_RUNTIME;
}
function createQueuedTaskRun(...args) {
	return getDetachedTaskLifecycleRuntime().createQueuedTaskRun(...args);
}
function createRunningTaskRun(...args) {
	return getDetachedTaskLifecycleRuntime().createRunningTaskRun(...args);
}
function startTaskRunByRunId(...args) {
	return getDetachedTaskLifecycleRuntime().startTaskRunByRunId(...args);
}
function recordTaskRunProgressByRunId(...args) {
	return getDetachedTaskLifecycleRuntime().recordTaskRunProgressByRunId(...args);
}
function finalizeTaskRunByRunId(params) {
	const runtime = getDetachedTaskLifecycleRuntime();
	if (runtime.finalizeTaskRunByRunId) return runtime.finalizeTaskRunByRunId(params);
	if (params.status === "succeeded") return runtime.completeTaskRunByRunId(params);
	return runtime.failTaskRunByRunId({
		...params,
		status: params.status
	});
}
function completeTaskRunByRunId(...args) {
	return getDetachedTaskLifecycleRuntime().completeTaskRunByRunId(...args);
}
function failTaskRunByRunId(...args) {
	return getDetachedTaskLifecycleRuntime().failTaskRunByRunId(...args);
}
function setDetachedTaskDeliveryStatusByRunId(...args) {
	return getDetachedTaskLifecycleRuntime().setDetachedTaskDeliveryStatusByRunId(...args);
}
function cancelDetachedTaskRunById(...args) {
	return getDetachedTaskLifecycleRuntime().cancelDetachedTaskRunById(...args);
}
async function tryRecoverTaskBeforeMarkLost(params) {
	const hook = getDetachedTaskLifecycleRuntime().tryRecoverTaskBeforeMarkLost;
	if (!hook) return { recovered: false };
	const startedAt = Date.now();
	try {
		const result = await hook(params);
		const elapsedMs = Date.now() - startedAt;
		if (elapsedMs >= DETACHED_TASK_RECOVERY_WARN_MS) log.warn("Detached task recovery hook was slow", {
			taskId: params.taskId,
			runtime: params.runtime,
			elapsedMs
		});
		if (result && typeof result.recovered === "boolean") return result;
		log.warn("Detached task recovery hook returned invalid result, proceeding with markTaskLost", {
			taskId: params.taskId,
			runtime: params.runtime,
			result
		});
		return { recovered: false };
	} catch (err) {
		log.warn("Detached task recovery hook threw, proceeding with markTaskLost", {
			taskId: params.taskId,
			runtime: params.runtime,
			elapsedMs: Date.now() - startedAt,
			error: err
		});
		return { recovered: false };
	}
}
//#endregion
export { failTaskRunByRunId as a, recordTaskRunProgressByRunId as c, tryRecoverTaskBeforeMarkLost as d, createRunningTaskRun as i, setDetachedTaskDeliveryStatusByRunId as l, completeTaskRunByRunId as n, finalizeTaskRunByRunId as o, createQueuedTaskRun as r, getDetachedTaskLifecycleRuntime as s, cancelDetachedTaskRunById as t, startTaskRunByRunId as u };
