import { _ as listTasksForSessionKey, p as listTasksForAgentId, s as getTaskById } from "./task-registry-B9ljq8Nk.js";
//#region src/tasks/task-status-access.ts
function getTaskSessionLookupByIdForStatus(taskId) {
	const task = getTaskById(taskId);
	return task ? {
		requesterSessionKey: task.requesterSessionKey,
		...task.runId ? { runId: task.runId } : {},
		...task.agentId ? { agentId: task.agentId } : {}
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
