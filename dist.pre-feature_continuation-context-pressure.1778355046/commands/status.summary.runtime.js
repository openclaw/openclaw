import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "../string-coerce-Bje8XVt9.js";
import { n as resolveAgentModelPrimaryValue } from "../model-input-gjsFWrBi.js";
import { i as isCronSessionKey } from "../session-key-utils-8PXPWO4Z.js";
import { r as normalizeProviderId } from "../provider-id-DIRgKpoh.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "../defaults-xppxcKrw.js";
import { C as parseModelRef, y as resolveConfiguredProviderFallback } from "../model-selection-shared-BQtX8Bw-.js";
import { l as resolvePersistedSelectedModelRef } from "../model-selection-CyWx9aXc.js";
import { t as resolveAgentRuntimeMetadata } from "../agent-runtime-metadata-hG-lV5hG.js";
import { i as selectAgentHarness } from "../selection-6cKfH77r.js";
import { t as resolveAgentRuntimeLabel } from "../agent-runtime-label-vBOUqQxd.js";
//#region src/commands/status.summary.runtime.ts
function resolveStatusModelRefFromRaw(params) {
	const trimmed = params.rawModel.trim();
	if (!trimmed) return null;
	const configuredModels = params.cfg.agents?.defaults?.models ?? {};
	if (!trimmed.includes("/")) {
		const aliasKey = normalizeLowercaseStringOrEmpty(trimmed);
		for (const [modelKey, entry] of Object.entries(configuredModels)) {
			const aliasValue = entry?.alias;
			const alias = normalizeOptionalString(aliasValue) ?? "";
			if (!alias || normalizeOptionalLowercaseString(alias) !== aliasKey) continue;
			const parsed = parseModelRef(modelKey, params.defaultProvider, { allowPluginNormalization: false });
			if (parsed) return parsed;
		}
		return {
			provider: params.defaultProvider,
			model: trimmed
		};
	}
	return parseModelRef(trimmed, params.defaultProvider, { allowPluginNormalization: false });
}
function resolveConfiguredStatusModelRef(params) {
	const agentRawModel = params.agentId ? resolveAgentModelPrimaryValue(params.cfg.agents?.list?.find((entry) => entry?.id === params.agentId)?.model) : void 0;
	if (agentRawModel) {
		const parsed = resolveStatusModelRefFromRaw({
			cfg: params.cfg,
			rawModel: agentRawModel,
			defaultProvider: params.defaultProvider
		});
		if (parsed) return parsed;
	}
	const defaultsRawModel = resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model);
	if (defaultsRawModel) {
		const parsed = resolveStatusModelRefFromRaw({
			cfg: params.cfg,
			rawModel: defaultsRawModel,
			defaultProvider: params.defaultProvider
		});
		if (parsed) return parsed;
	}
	const fallbackProvider = resolveConfiguredProviderFallback({
		cfg: params.cfg,
		defaultProvider: params.defaultProvider
	});
	if (fallbackProvider) return fallbackProvider;
	return {
		provider: params.defaultProvider,
		model: params.defaultModel
	};
}
function resolveConfiguredProviderContextTokens(cfg, provider, model) {
	const providers = cfg?.models?.providers;
	if (!providers || typeof providers !== "object") return;
	const providerKey = normalizeProviderId(provider);
	for (const [id, providerConfig] of Object.entries(providers)) {
		if (normalizeProviderId(id) !== providerKey || !Array.isArray(providerConfig?.models)) continue;
		for (const entry of providerConfig.models) {
			const contextTokens = typeof entry?.contextTokens === "number" ? entry.contextTokens : typeof entry?.contextWindow === "number" ? entry.contextWindow : void 0;
			if (typeof entry?.id === "string" && entry.id === model && typeof contextTokens === "number" && contextTokens > 0) return contextTokens;
		}
	}
}
function classifySessionKey(key, entry) {
	if (key === "global") return "global";
	if (key === "unknown") return "unknown";
	if (isCronSessionKey(key)) return "cron";
	if (entry?.chatType === "group" || entry?.chatType === "channel") return "group";
	if (key.includes(":group:") || key.includes(":channel:")) return "group";
	return "direct";
}
function resolveSessionModelRef(cfg, entry, agentId) {
	const resolved = resolveConfiguredStatusModelRef({
		cfg,
		defaultProvider: DEFAULT_PROVIDER,
		defaultModel: DEFAULT_MODEL,
		agentId
	});
	return resolvePersistedSelectedModelRef({
		defaultProvider: resolved.provider || "openai",
		runtimeProvider: entry?.modelProvider,
		runtimeModel: entry?.model,
		overrideProvider: entry?.providerOverride,
		overrideModel: entry?.modelOverride,
		allowPluginNormalization: false
	}) ?? resolved;
}
function resolveSessionRuntimeLabel(params) {
	const agentRuntime = resolveAgentRuntimeMetadata(params.cfg, params.agentId ?? "");
	const explicitRuntime = normalizeOptionalLowercaseString(params.entry?.agentRuntimeOverride) ?? normalizeOptionalLowercaseString(params.entry?.agentHarnessId) ?? (agentRuntime.source === "implicit" ? void 0 : normalizeOptionalLowercaseString(agentRuntime.id));
	if (explicitRuntime && explicitRuntime !== "auto" && explicitRuntime !== "default") return resolveAgentRuntimeLabel({
		config: params.cfg,
		sessionEntry: params.entry,
		resolvedHarness: explicitRuntime,
		fallbackProvider: params.provider
	});
	let resolvedHarness;
	try {
		const id = normalizeOptionalLowercaseString(selectAgentHarness({
			provider: params.provider,
			modelId: params.model,
			config: params.cfg,
			agentId: params.agentId,
			sessionKey: params.sessionKey,
			agentHarnessId: params.entry?.agentHarnessId
		}).id);
		resolvedHarness = id && id !== "pi" ? id : void 0;
	} catch {
		resolvedHarness = void 0;
	}
	return resolveAgentRuntimeLabel({
		config: params.cfg,
		sessionEntry: params.entry,
		resolvedHarness,
		fallbackProvider: params.provider
	});
}
function resolveContextTokensForModel(params) {
	params.allowAsyncLoad;
	if (typeof params.contextTokensOverride === "number" && params.contextTokensOverride > 0) return params.contextTokensOverride;
	if (params.provider && params.model) {
		const configuredContextTokens = resolveConfiguredProviderContextTokens(params.cfg, params.provider, params.model);
		if (configuredContextTokens !== void 0) return configuredContextTokens;
	}
	return params.fallbackContextTokens ?? 2e5;
}
const statusSummaryRuntime = {
	resolveContextTokensForModel,
	classifySessionKey,
	resolveSessionModelRef,
	resolveSessionRuntimeLabel,
	resolveConfiguredStatusModelRef
};
//#endregion
export { statusSummaryRuntime };
