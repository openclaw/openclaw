import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { m as listTasksForOwnerKey } from "./task-registry-DFUW-xBJ.js";
import "./runtime-internal-Bqu0JS7i.js";
//#region src/agents/session-async-task-status.ts
const DEFAULT_ACTIVE_STATUSES = new Set(["queued", "running"]);
function findActiveSessionTask(params) {
	const normalizedSessionKey = normalizeOptionalString(params.sessionKey);
	if (!normalizedSessionKey) return;
	const statuses = params.statuses ?? DEFAULT_ACTIVE_STATUSES;
	const taskKind = normalizeOptionalString(params.taskKind);
	const sourceIdPrefix = normalizeOptionalString(params.sourceIdPrefix);
	const matches = listTasksForOwnerKey(normalizedSessionKey).filter((task) => {
		if (task.scopeKind !== "session") return false;
		if (params.runtime && task.runtime !== params.runtime) return false;
		if (!statuses.has(task.status)) return false;
		if (taskKind && task.taskKind !== taskKind) return false;
		if (sourceIdPrefix) {
			const sourceId = normalizeOptionalString(task.sourceId) ?? "";
			if (sourceId !== sourceIdPrefix && !sourceId.startsWith(`${sourceIdPrefix}:`)) return false;
		}
		return true;
	});
	if (matches.length === 0) return;
	return matches.find((task) => task.status === "running") ?? matches[0];
}
function buildSessionAsyncTaskStatusDetails(task) {
	return {
		async: true,
		active: true,
		existingTask: true,
		status: task.status,
		task: {
			taskId: task.taskId,
			...task.runId ? { runId: task.runId } : {}
		},
		...task.taskKind ? { taskKind: task.taskKind } : {},
		...task.progressSummary ? { progressSummary: task.progressSummary } : {},
		...task.sourceId ? { sourceId: task.sourceId } : {}
	};
}
//#endregion
export { findActiveSessionTask as n, buildSessionAsyncTaskStatusDetails as t };
