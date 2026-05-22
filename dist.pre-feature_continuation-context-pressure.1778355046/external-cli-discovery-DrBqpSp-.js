import { n as resolveAgentModelPrimaryValue, t as resolveAgentModelFallbackValues } from "./model-input-gjsFWrBi.js";
import { r as normalizeProviderId } from "./provider-id-DIRgKpoh.js";
//#region src/agents/auth-profiles/external-cli-scope.ts
function addProviderScopeId(out, value) {
	const raw = value?.trim();
	if (!raw) return;
	out.add(raw);
	const normalized = normalizeProviderId(raw);
	if (normalized) out.add(normalized);
}
function addProviderScopeFromModelRef(out, value) {
	const raw = value?.trim();
	if (!raw) return;
	const slash = raw.indexOf("/");
	if (slash <= 0) return;
	addProviderScopeId(out, raw.slice(0, slash));
}
function addProviderScopeFromModelConfig(out, model) {
	addProviderScopeFromModelRef(out, resolveAgentModelPrimaryValue(model));
	for (const fallback of resolveAgentModelFallbackValues(model)) addProviderScopeFromModelRef(out, fallback);
}
function addExternalCliRuntimeScope(out, value) {
	const normalized = normalizeProviderId(value?.trim() ?? "");
	if (normalized === "claude-cli" || normalized === "codex" || normalized === "codex-cli" || normalized === "codex-app-server" || normalized === "openai-codex" || normalized === "minimax" || normalized === "minimax-cli" || normalized === "minimax-portal") addProviderScopeId(out, normalized);
}
function resolveExternalCliAuthScopeFromConfig(cfg) {
	const providerIds = /* @__PURE__ */ new Set();
	const profileIds = /* @__PURE__ */ new Set();
	for (const id of Object.keys(cfg.models?.providers ?? {})) addProviderScopeId(providerIds, id);
	for (const [profileId, profile] of Object.entries(cfg.auth?.profiles ?? {})) {
		const normalizedProfileId = profileId.trim();
		if (normalizedProfileId) profileIds.add(normalizedProfileId);
		addProviderScopeId(providerIds, profile?.provider);
	}
	for (const [provider, orderedProfileIds] of Object.entries(cfg.auth?.order ?? {})) {
		addProviderScopeId(providerIds, provider);
		for (const profileId of orderedProfileIds ?? []) {
			const normalizedProfileId = profileId.trim();
			if (normalizedProfileId) profileIds.add(normalizedProfileId);
		}
	}
	const defaults = cfg.agents?.defaults;
	addProviderScopeFromModelConfig(providerIds, defaults?.model);
	addProviderScopeFromModelConfig(providerIds, defaults?.imageModel);
	addProviderScopeFromModelConfig(providerIds, defaults?.imageGenerationModel);
	addProviderScopeFromModelConfig(providerIds, defaults?.videoGenerationModel);
	addProviderScopeFromModelConfig(providerIds, defaults?.musicGenerationModel);
	addProviderScopeFromModelConfig(providerIds, defaults?.pdfModel);
	addExternalCliRuntimeScope(providerIds, defaults?.agentRuntime?.id);
	addExternalCliRuntimeScope(providerIds, defaults?.embeddedHarness?.runtime);
	for (const agent of cfg.agents?.list ?? []) {
		addProviderScopeFromModelConfig(providerIds, agent.model);
		addProviderScopeFromModelConfig(providerIds, agent.subagents?.model);
		addExternalCliRuntimeScope(providerIds, agent.agentRuntime?.id);
		addExternalCliRuntimeScope(providerIds, agent.embeddedHarness?.runtime);
	}
	if (providerIds.size === 0 && profileIds.size === 0) return;
	return {
		providerIds: [...providerIds].toSorted((left, right) => left.localeCompare(right)),
		profileIds: [...profileIds].toSorted((left, right) => left.localeCompare(right))
	};
}
//#endregion
//#region src/agents/auth-profiles/external-cli-discovery.ts
function normalizeStringList(values) {
	return [...values].map((value) => value?.trim()).filter((value) => Boolean(value));
}
function externalCliDiscoveryNone(params) {
	return {
		mode: "none",
		allowKeychainPrompt: false,
		...params?.config ? { config: params.config } : {}
	};
}
function externalCliDiscoveryExisting(params) {
	return {
		mode: "existing",
		...params?.allowKeychainPrompt !== void 0 ? { allowKeychainPrompt: params.allowKeychainPrompt } : {},
		...params?.config ? { config: params.config } : {}
	};
}
function externalCliDiscoveryScoped(params) {
	return {
		mode: "scoped",
		...params.allowKeychainPrompt !== void 0 ? { allowKeychainPrompt: params.allowKeychainPrompt } : {},
		...params.config ? { config: params.config } : {},
		...params.providerIds ? { providerIds: params.providerIds } : {},
		...params.profileIds ? { profileIds: params.profileIds } : {}
	};
}
function externalCliDiscoveryForProviderAuth(params) {
	const profileIds = normalizeStringList([params.profileId, params.preferredProfile]);
	return externalCliDiscoveryScoped({
		config: params.cfg,
		allowKeychainPrompt: params.allowKeychainPrompt ?? false,
		providerIds: [params.provider],
		...profileIds.length > 0 ? { profileIds } : {}
	});
}
function externalCliDiscoveryForConfigStatus(params) {
	const scope = resolveExternalCliAuthScopeFromConfig(params.cfg);
	return externalCliDiscoveryFromScope({
		cfg: params.cfg,
		scope,
		allowKeychainPrompt: params.allowKeychainPrompt ?? false
	});
}
function externalCliDiscoveryForProviders(params) {
	const providers = normalizeStringList(params.providers);
	if (providers.length === 0) return externalCliDiscoveryNone({ config: params.cfg });
	return externalCliDiscoveryScoped({
		config: params.cfg,
		allowKeychainPrompt: params.allowKeychainPrompt ?? false,
		providerIds: providers
	});
}
function externalCliDiscoveryFromScope(params) {
	if (!params.scope) return externalCliDiscoveryNone({ config: params.cfg });
	return externalCliDiscoveryScoped({
		config: params.cfg,
		allowKeychainPrompt: params.allowKeychainPrompt,
		providerIds: params.scope.providerIds,
		profileIds: params.scope.profileIds
	});
}
//#endregion
export { externalCliDiscoveryNone as a, externalCliDiscoveryForProviders as i, externalCliDiscoveryForConfigStatus as n, externalCliDiscoveryScoped as o, externalCliDiscoveryForProviderAuth as r, externalCliDiscoveryExisting as t };
