import { f as listTasksForAgentId, g as listTasksForSessionKey, s as getTaskById } from "./task-registry-DFUW-xBJ.js";
//#region src/tasks/task-status-access.ts
function getTaskSessionLookupByIdForStatus(taskId) {
	const task = getTaskById(taskId);
	return task ? {
		requesterSessionKey: task.requesterSessionKey,
		...task.runId ? { runId: task.runId } : {}
	} : void 0;
}
function listTasksForSessionKeyForStatus(sessionKey) {
	return listTasksForSessionKey(sessionKey);
}
function listTasksForAgentIdForStatus(agentId) {
	return listTasksForAgentId(agentId);
}
//#endregion
export { listTasksForAgentIdForStatus as n, listTasksForSessionKeyForStatus as r, getTaskSessionLookupByIdForStatus as t };
