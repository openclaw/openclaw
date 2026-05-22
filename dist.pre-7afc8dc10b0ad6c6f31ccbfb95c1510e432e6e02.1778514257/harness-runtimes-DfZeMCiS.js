import { s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { c as isRecord } from "./utils-927g1oFZ.js";
import { r as normalizeProviderId } from "./provider-id-BvxMxU5i.js";
import { t as resolveModelRuntimePolicy } from "./model-runtime-policy-4lNwKpNk.js";
import { t as normalizeEmbeddedAgentRuntime } from "./runtime-BsEyeI_y.js";
import { i as modelSelectionShouldEnsureCodexPlugin } from "./openai-codex-routing-Tk9OL05P.js";
//#region src/agents/harness-runtimes.ts
function normalizeRuntimeId(value) {
	if (typeof value !== "string") return;
	const lower = normalizeOptionalLowercaseString(value);
	if (!lower) return;
	return normalizeOptionalLowercaseString(normalizeEmbeddedAgentRuntime(lower));
}
function listAgentModelRefs(value) {
	if (typeof value === "string") return [value];
	if (!isRecord(value)) return [];
	const refs = [];
	if (typeof value.primary === "string") refs.push(value.primary);
	if (Array.isArray(value.fallbacks)) {
		for (const fallback of value.fallbacks) if (typeof fallback === "string") refs.push(fallback);
	}
	return refs;
}
function parseConfiguredModelRef(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash >= trimmed.length - 1) return;
	return {
		provider: normalizeProviderId(trimmed.slice(0, slash)),
		modelId: trimmed.slice(slash + 1).trim()
	};
}
function hasOpenAIModelRef(config, value, agentId) {
	return listAgentModelRefs(value).some((ref) => {
		if (!modelSelectionShouldEnsureCodexPlugin({
			model: ref,
			config
		})) return false;
		const parsed = parseConfiguredModelRef(ref);
		const runtime = normalizeRuntimeId(resolveModelRuntimePolicy({
			config,
			provider: parsed?.provider,
			modelId: parsed?.modelId,
			agentId
		}).policy?.id);
		return !runtime || runtime === "auto" || runtime === "codex";
	});
}
function pushConfiguredModelRuntimeIds(config, runtimes) {
	for (const providerConfig of Object.values(config.models?.providers ?? {})) {
		const providerRuntime = normalizeRuntimeId(providerConfig?.agentRuntime?.id);
		if (providerRuntime && providerRuntime !== "auto" && providerRuntime !== "pi") runtimes.add(providerRuntime);
		for (const modelConfig of providerConfig?.models ?? []) {
			const modelRuntime = normalizeRuntimeId(modelConfig?.agentRuntime?.id);
			if (modelRuntime && modelRuntime !== "auto" && modelRuntime !== "pi") runtimes.add(modelRuntime);
		}
	}
	const pushModelMapRuntimeIds = (models) => {
		if (!isRecord(models)) return;
		for (const entry of Object.values(models)) {
			if (!isRecord(entry)) continue;
			const runtime = normalizeRuntimeId(isRecord(entry.agentRuntime) ? entry.agentRuntime.id : void 0);
			if (runtime && runtime !== "auto" && runtime !== "pi") runtimes.add(runtime);
		}
	};
	pushModelMapRuntimeIds(config.agents?.defaults?.models);
	for (const agent of config.agents?.list ?? []) pushModelMapRuntimeIds(agent.models);
}
function pushLegacyAgentRuntimeIds(config, runtimes) {
	const pushRuntimeId = (value) => {
		const runtime = normalizeRuntimeId(value);
		if (runtime && runtime !== "auto" && runtime !== "pi") runtimes.add(runtime);
	};
	pushRuntimeId(config.agents?.defaults?.agentRuntime?.id);
	for (const agent of config.agents?.list ?? []) pushRuntimeId(agent.agentRuntime?.id);
}
function collectConfiguredAgentHarnessRuntimes(config, env, options = {}) {
	const runtimes = /* @__PURE__ */ new Set();
	const includeEnvRuntime = options.includeEnvRuntime ?? true;
	const includeLegacyAgentRuntimes = options.includeLegacyAgentRuntimes ?? true;
	const pushCodexForOpenAIModel = (model, agentId) => {
		if (hasOpenAIModelRef(config, model, agentId)) runtimes.add("codex");
	};
	if (includeEnvRuntime) {
		const envRuntime = normalizeRuntimeId(env.OPENCLAW_AGENT_RUNTIME);
		if (envRuntime && envRuntime !== "auto" && envRuntime !== "pi") runtimes.add(envRuntime);
	}
	pushConfiguredModelRuntimeIds(config, runtimes);
	if (includeLegacyAgentRuntimes) pushLegacyAgentRuntimeIds(config, runtimes);
	const defaultsModel = config.agents?.defaults?.model;
	pushCodexForOpenAIModel(defaultsModel);
	if (Array.isArray(config.agents?.list)) for (const agent of config.agents.list) {
		if (!isRecord(agent)) continue;
		pushCodexForOpenAIModel(agent.model ?? defaultsModel, typeof agent.id === "string" ? agent.id : void 0);
	}
	return [...runtimes].toSorted((left, right) => left.localeCompare(right));
}
//#endregion
export { collectConfiguredAgentHarnessRuntimes as t };
