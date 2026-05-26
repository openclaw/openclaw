//#region src/agents/subagent-registry-steer-runtime.ts
let replaceSubagentRunAfterSteerImpl = null;
let finalizeInterruptedSubagentRunImpl = null;
function configureSubagentRegistrySteerRuntime(params) {
	replaceSubagentRunAfterSteerImpl = params.replaceSubagentRunAfterSteer;
	finalizeInterruptedSubagentRunImpl = params.finalizeInterruptedSubagentRun ?? null;
}
function replaceSubagentRunAfterSteer(params) {
	return replaceSubagentRunAfterSteerImpl?.(params) ?? false;
}
async function finalizeInterruptedSubagentRun(params) {
	return await finalizeInterruptedSubagentRunImpl?.(params) ?? 0;
}
//#endregion
export { finalizeInterruptedSubagentRun as n, replaceSubagentRunAfterSteer as r, configureSubagentRegistrySteerRuntime as t };
