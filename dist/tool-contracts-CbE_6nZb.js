import { a as getActivePluginRegistry } from "./runtime-DHxRl5F1.js";
//#region src/plugins/agent-tool-result-middleware.ts
const AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIMES = ["pi", "codex"];
const AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIME_SET = new Set(AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIMES);
function normalizeAgentToolResultMiddlewareRuntime(runtime) {
	const normalized = runtime.trim().toLowerCase();
	if (normalized === "codex-app-server") return "codex";
	return AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIME_SET.has(normalized) ? normalized : void 0;
}
function normalizeAgentToolResultMiddlewareRuntimes(options) {
	const requested = options?.runtimes ?? options?.harnesses;
	if (!requested) return [...AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIMES];
	const normalized = [];
	for (const runtime of requested) {
		const value = normalizeAgentToolResultMiddlewareRuntime(runtime);
		if (!value) continue;
		if (!normalized.includes(value)) normalized.push(value);
	}
	return normalized;
}
function normalizeAgentToolResultMiddlewareRuntimeIds(runtimes) {
	const normalized = [];
	for (const runtime of runtimes ?? []) {
		const value = normalizeAgentToolResultMiddlewareRuntime(runtime);
		if (value && !normalized.includes(value)) normalized.push(value);
	}
	return normalized;
}
function listAgentToolResultMiddlewares(runtime) {
	return getActivePluginRegistry()?.agentToolResultMiddlewares?.filter((entry) => entry.runtimes.includes(runtime)).map((entry) => entry.handler) ?? [];
}
//#endregion
//#region src/plugins/tool-contracts.ts
function normalizePluginToolContractNames(contracts) {
	return normalizePluginToolNames(contracts?.tools);
}
function normalizePluginToolNames(names) {
	const normalized = /* @__PURE__ */ new Set();
	for (const name of names ?? []) {
		const trimmed = name.trim();
		if (trimmed) normalized.add(trimmed);
	}
	return [...normalized];
}
function findUndeclaredPluginToolNames(params) {
	const declared = new Set(normalizePluginToolNames(params.declaredNames));
	return normalizePluginToolNames(params.toolNames).filter((name) => !declared.has(name));
}
//#endregion
export { normalizeAgentToolResultMiddlewareRuntimeIds as a, listAgentToolResultMiddlewares as i, normalizePluginToolContractNames as n, normalizeAgentToolResultMiddlewareRuntimes as o, normalizePluginToolNames as r, findUndeclaredPluginToolNames as t };
