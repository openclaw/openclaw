import { r as normalizeProviderId } from "./provider-id-Cz7K6wgK.js";
import { c as normalizeAgentId } from "./session-key-DFEyR49L.js";
import { t as listAgentEntries } from "./agent-scope-config-26EcJVc0.js";
import { m as resolveSessionAgentIds } from "./agent-scope-C1Fl7gAf.js";
//#region src/agents/model-runtime-policy.ts
function hasRuntimePolicy(value) {
	return Boolean(value?.id?.trim());
}
function resolveProviderConfig(config, provider) {
	if (!config?.models?.providers || !provider?.trim()) return;
	const providers = config.models.providers;
	const direct = providers[provider];
	if (direct) return direct;
	const normalizedProvider = normalizeProviderId(provider);
	for (const [candidateProvider, providerConfig] of Object.entries(providers)) if (normalizeProviderId(candidateProvider) === normalizedProvider) return providerConfig;
}
function normalizeModelIdForProvider(provider, modelId) {
	const trimmed = modelId?.trim();
	if (!trimmed) return;
	const slash = trimmed.indexOf("/");
	if (slash <= 0) return trimmed;
	const modelProvider = normalizeProviderId(trimmed.slice(0, slash));
	const expectedProvider = normalizeProviderId(provider ?? "");
	if (expectedProvider && modelProvider !== expectedProvider) return;
	return trimmed.slice(slash + 1).trim() || void 0;
}
function modelEntryMatches(params) {
	const entryId = params.entry.id.trim();
	if (entryId === params.modelId) return true;
	const slash = entryId.indexOf("/");
	if (slash <= 0) return false;
	return normalizeProviderId(entryId.slice(0, slash)) === normalizeProviderId(params.provider ?? "") && entryId.slice(slash + 1).trim() === params.modelId;
}
function modelKeyMatches(params) {
	return modelEntryMatches({
		entry: { id: params.key },
		provider: params.provider,
		modelId: params.modelId
	});
}
function resolveAgentModelEntryRuntimePolicy(params) {
	const modelId = normalizeModelIdForProvider(params.provider, params.modelId);
	if (!params.config || !modelId) return {};
	const { sessionAgentId } = resolveSessionAgentIds({
		config: params.config,
		agentId: params.agentId,
		sessionKey: params.sessionKey
	});
	const modelMaps = [listAgentEntries(params.config).find((entry) => normalizeAgentId(entry.id) === sessionAgentId)?.models, params.config.agents?.defaults?.models];
	for (const models of modelMaps) for (const [key, entry] of Object.entries(models ?? {})) if (modelKeyMatches({
		key,
		provider: params.provider,
		modelId
	}) && hasRuntimePolicy(entry?.agentRuntime)) return {
		policy: entry.agentRuntime,
		source: "model"
	};
	return {};
}
function resolveModelConfig(params) {
	const modelId = normalizeModelIdForProvider(params.provider, params.modelId);
	if (!modelId || !Array.isArray(params.providerConfig?.models)) return;
	return params.providerConfig.models.find((entry) => modelEntryMatches({
		entry,
		provider: params.provider,
		modelId
	}));
}
function resolveModelRuntimePolicy(params) {
	const agentModelPolicy = resolveAgentModelEntryRuntimePolicy(params);
	if (agentModelPolicy.policy) return agentModelPolicy;
	const providerConfig = resolveProviderConfig(params.config, params.provider);
	const modelConfig = resolveModelConfig({
		providerConfig,
		provider: params.provider,
		modelId: params.modelId
	});
	if (hasRuntimePolicy(modelConfig?.agentRuntime)) return {
		policy: modelConfig?.agentRuntime,
		source: "model"
	};
	if (hasRuntimePolicy(providerConfig?.agentRuntime)) return {
		policy: providerConfig?.agentRuntime,
		source: "provider"
	};
	return {};
}
//#endregion
export { resolveModelRuntimePolicy as t };
