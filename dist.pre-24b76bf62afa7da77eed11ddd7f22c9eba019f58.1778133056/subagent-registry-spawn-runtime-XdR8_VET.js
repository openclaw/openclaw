//#region src/agents/subagent-registry-spawn-runtime.ts
let countActiveRunsForSessionImpl = null;
let registerSubagentRunImpl = null;
function configureSubagentRegistrySpawnRuntime(params) {
	countActiveRunsForSessionImpl = params.countActiveRunsForSession;
	registerSubagentRunImpl = params.registerSubagentRun;
}
function countActiveRunsForSession(requesterSessionKey) {
	if (!countActiveRunsForSessionImpl) {
		console.warn("[subagent-registry-spawn-runtime] countActiveRunsForSession called before configureSubagentRegistrySpawnRuntime()");
		return 0;
	}
	return countActiveRunsForSessionImpl(requesterSessionKey);
}
function registerSubagentRun(params) {
	if (!registerSubagentRunImpl) {
		console.warn("[subagent-registry-spawn-runtime] registerSubagentRun called before configureSubagentRegistrySpawnRuntime()");
		return;
	}
	registerSubagentRunImpl(params);
}
//#endregion
export { countActiveRunsForSession as n, registerSubagentRun as r, configureSubagentRegistrySpawnRuntime as t };
