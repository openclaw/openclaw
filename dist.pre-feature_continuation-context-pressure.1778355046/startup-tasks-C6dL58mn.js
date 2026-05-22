import { i as formatErrorMessage } from "./errors-QN8rySzW.js";
//#region src/gateway/startup-tasks.ts
function taskMeta(task, result) {
	return {
		source: task.source,
		...task.agentId ? { agentId: task.agentId } : {},
		...task.sessionKey ? { sessionKey: task.sessionKey } : {},
		...task.workspaceDir ? { workspaceDir: task.workspaceDir } : {},
		...result?.status === "failed" || result?.status === "skipped" ? { reason: result.reason } : {}
	};
}
async function runStartupTasks(params) {
	const results = [];
	for (const task of params.tasks) {
		let result;
		try {
			result = await task.run();
		} catch (err) {
			result = {
				status: "failed",
				reason: formatErrorMessage(err)
			};
		}
		results.push(result);
		if (result.status === "failed") {
			params.log.warn("startup task failed", taskMeta(task, result));
			continue;
		}
		if (result.status === "skipped") params.log.debug("startup task skipped", taskMeta(task, result));
	}
	return results;
}
//#endregion
export { runStartupTasks as t };
