//#region src/agents/agent-runtime-policy.ts
function resolveAgentRuntimePolicy(container) {
	const preferred = container?.agentRuntime;
	if (hasAgentRuntimePolicy(preferred)) return preferred;
}
function hasAgentRuntimePolicy(value) {
	return Boolean(value?.id?.trim() || value?.fallback);
}
//#endregion
export { resolveAgentRuntimePolicy as t };
