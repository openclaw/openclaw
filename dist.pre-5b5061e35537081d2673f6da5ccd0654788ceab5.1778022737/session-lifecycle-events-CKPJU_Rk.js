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
//#region src/sessions/session-lifecycle-events.ts
const SESSION_LIFECYCLE_LISTENERS = /* @__PURE__ */ new Set();
function onSessionLifecycleEvent(listener) {
	SESSION_LIFECYCLE_LISTENERS.add(listener);
	return () => {
		SESSION_LIFECYCLE_LISTENERS.delete(listener);
	};
}
function emitSessionLifecycleEvent(event) {
	for (const listener of SESSION_LIFECYCLE_LISTENERS) try {
		listener(event);
	} catch {}
}
//#endregion
export { registerSubagentRun as a, countActiveRunsForSession as i, onSessionLifecycleEvent as n, configureSubagentRegistrySpawnRuntime as r, emitSessionLifecycleEvent as t };
