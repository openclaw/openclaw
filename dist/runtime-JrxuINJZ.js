import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { s as resolveDefaultAgentDir } from "./agent-scope-config-CMp71_27.js";
import { i as resolveManifestContractOwnerPluginId } from "./plugin-registry-CgH_ZSlH.js";
import { r as logVerbose } from "./globals-YU5FjfZK.js";
import { g as selectApplicableRuntimeConfig, i as getRuntimeConfigSnapshot, s as getRuntimeConfigSourceSnapshot } from "./runtime-snapshot-DgdkBEdP.js";
import { n as getActiveRuntimeWebToolsMetadata } from "./runtime-web-tools-state-BgXXPpNN.js";
import { i as hasAuthProfileForProvider } from "./model-config.helpers-6EP_rOvT.js";
import { r as sortWebSearchProvidersForAutoDetect } from "./web-search-providers.shared-C_XvZwgr.js";
import { n as resolveRuntimeWebSearchProviders, t as resolvePluginWebSearchProviders } from "./web-search-providers.runtime.js";
import { i as resolveWebProviderConfig, n as providerRequiresCredential, r as readWebProviderEnvValue, t as hasWebProviderEntryCredential } from "./provider-runtime-shared-B1Ic1Utb.js";
//#region src/web-search/runtime.ts
function resolveSearchConfig(cfg) {
	return resolveWebProviderConfig(cfg, "search");
}
function resolveWebSearchRuntimeConfig(params) {
	if (params?.preferInputConfig && params.config) return params.config;
	return selectApplicableRuntimeConfig({
		inputConfig: params?.config,
		runtimeConfig: getRuntimeConfigSnapshot(),
		runtimeSourceConfig: getRuntimeConfigSourceSnapshot()
	});
}
function resolveWebSearchEnabled(params) {
	if (typeof params.search?.enabled === "boolean") return params.search.enabled;
	if (params.sandboxed) return true;
	return true;
}
function hasEntryCredential(provider, config, search, agentDir) {
	return hasWebProviderEntryCredential({
		provider,
		config,
		toolConfig: search,
		resolveRawValue: ({ provider: currentProvider, config: currentConfig }) => currentProvider.getConfiguredCredentialValue?.(currentConfig),
		resolveFallbackRawValue: ({ provider: currentProvider, config: currentConfig }) => currentProvider.getConfiguredCredentialFallback?.(currentConfig)?.value,
		resolveEnvValue: ({ provider: currentProvider, configuredEnvVarId }) => (configuredEnvVarId ? readWebProviderEnvValue([configuredEnvVarId]) : void 0) ?? readWebProviderEnvValue(currentProvider.envVars),
		resolveProviderAuthValue: (providerId) => hasAuthProfileForProvider({
			provider: providerId,
			agentDir: agentDir?.trim() || resolveDefaultAgentDir(config ?? {})
		})
	});
}
function isWebSearchProviderConfigured(params) {
	const config = resolveWebSearchRuntimeConfig({ config: params.config });
	return hasEntryCredential(params.provider, config, resolveSearchConfig(config));
}
function listWebSearchProviders(params) {
	return resolveRuntimeWebSearchProviders({
		config: resolveWebSearchRuntimeConfig({ config: params?.config }),
		bundledAllowlistCompat: true
	});
}
function listConfiguredWebSearchProviders(params) {
	return resolvePluginWebSearchProviders({
		config: resolveWebSearchRuntimeConfig({ config: params?.config }),
		bundledAllowlistCompat: true
	});
}
function resolveWebSearchProviderId(params) {
	const config = resolveWebSearchRuntimeConfig({ config: params.config });
	const search = params.search ?? resolveSearchConfig(config);
	const providers = sortWebSearchProvidersForAutoDetect(params.providers ?? resolvePluginWebSearchProviders({
		config,
		bundledAllowlistCompat: true
	}));
	const raw = search && "provider" in search ? normalizeLowercaseStringOrEmpty(search.provider) : "";
	if (raw) {
		const explicit = providers.find((provider) => provider.id === raw);
		if (explicit) return explicit.id;
	}
	if (!raw) {
		let keylessFallbackProviderId = "";
		for (const provider of providers) {
			if (!providerRequiresCredential(provider)) {
				keylessFallbackProviderId ||= provider.id;
				continue;
			}
			if (!hasEntryCredential(provider, config, search, params.agentDir)) continue;
			logVerbose(`web_search: no provider configured, auto-detected "${provider.id}" from available credentials`);
			return provider.id;
		}
		if (keylessFallbackProviderId) {
			logVerbose(`web_search: no provider configured and no credentials found, falling back to keyless provider "${keylessFallbackProviderId}"`);
			return keylessFallbackProviderId;
		}
	}
	return providers[0]?.id ?? "";
}
function resolveExplicitWebSearchProviderId(params) {
	const callerProviderId = normalizeOptionalLowercaseString(params.providerId);
	if (callerProviderId) return callerProviderId;
	if (params.includeRuntimeSelection && params.runtimeWebSearch?.providerSource === "configured") {
		const runtimeProviderId = normalizeOptionalLowercaseString(params.runtimeWebSearch.selectedProvider ?? params.runtimeWebSearch.providerConfigured);
		if (runtimeProviderId) return runtimeProviderId;
	}
	const configuredProviderId = params.search && "provider" in params.search ? normalizeOptionalLowercaseString(params.search.provider) : void 0;
	if (configuredProviderId) return configuredProviderId;
}
function resolveExplicitWebSearchProviderPluginIds(params) {
	const providerId = resolveExplicitWebSearchProviderId(params);
	if (!providerId) return;
	const ownerPluginId = resolveManifestContractOwnerPluginId({
		config: params.config,
		contract: "webSearchProviders",
		value: providerId
	});
	return ownerPluginId ? [ownerPluginId] : void 0;
}
function resolveWebSearchProviderLoadScope(params) {
	const onlyPluginIds = resolveExplicitWebSearchProviderPluginIds(params);
	return onlyPluginIds ? { onlyPluginIds } : {};
}
function resolveWebSearchCandidates(options) {
	const config = resolveWebSearchRuntimeConfig({
		config: options?.config,
		preferInputConfig: options?.preferInputConfig
	});
	const search = resolveSearchConfig(config);
	const runtimeWebSearch = options?.runtimeWebSearch ?? getActiveRuntimeWebToolsMetadata()?.search;
	if (!resolveWebSearchEnabled({
		search,
		sandboxed: options?.sandboxed
	})) return [];
	const loadScope = resolveWebSearchProviderLoadScope({
		config,
		search,
		runtimeWebSearch,
		providerId: options?.providerId,
		includeRuntimeSelection: Boolean(options?.preferRuntimeProviders)
	});
	const providers = sortWebSearchProvidersForAutoDetect(options?.preferRuntimeProviders ? resolveRuntimeWebSearchProviders({
		config,
		bundledAllowlistCompat: true,
		...loadScope
	}) : resolvePluginWebSearchProviders({
		config,
		bundledAllowlistCompat: true,
		...loadScope
	})).filter(Boolean);
	if (providers.length === 0) return [];
	const preferredIds = [
		options?.providerId,
		runtimeWebSearch?.selectedProvider,
		runtimeWebSearch?.providerConfigured,
		resolveWebSearchProviderId({
			config,
			agentDir: options?.agentDir,
			search,
			providers
		})
	].filter((value, index, array) => Boolean(value) && array.indexOf(value) === index);
	const explicitProviderId = options?.providerId?.trim();
	if (explicitProviderId && !providers.some((entry) => entry.id === explicitProviderId)) throw new Error(`Unknown web_search provider "${explicitProviderId}".`);
	return [...preferredIds.map((id) => providers.find((entry) => entry.id === id)).filter((entry) => Boolean(entry)), ...providers.filter((entry) => !preferredIds.includes(entry.id))];
}
function hasExplicitWebSearchSelection(params) {
	if (params.providerId?.trim()) return true;
	const availableProviderIds = new Set((params.providers ?? []).map((provider) => normalizeLowercaseStringOrEmpty(provider.id)));
	const configuredProviderId = params.search && "provider" in params.search && typeof params.search.provider === "string" ? normalizeLowercaseStringOrEmpty(params.search.provider) : "";
	if (configuredProviderId && availableProviderIds.has(configuredProviderId)) return true;
	const runtimeConfiguredId = normalizeOptionalLowercaseString(params.runtimeWebSearch?.selectedProvider ?? params.runtimeWebSearch?.providerConfigured);
	if (params.runtimeWebSearch?.providerSource === "configured" && runtimeConfiguredId && availableProviderIds.has(runtimeConfiguredId)) return true;
	return false;
}
function isStructuredAvailabilityError(result) {
	if (!result || typeof result !== "object" || !("error" in result)) return false;
	const error = result.error;
	return typeof error === "string" && /^missing_[a-z0-9_]*api_key$/i.test(error);
}
async function runWebSearch(params) {
	const config = resolveWebSearchRuntimeConfig({
		config: params.config,
		preferInputConfig: params.preferInputConfig
	});
	const search = resolveSearchConfig(config);
	const runtimeWebSearch = params.runtimeWebSearch ?? getActiveRuntimeWebToolsMetadata()?.search;
	const candidates = resolveWebSearchCandidates({
		...params,
		config,
		runtimeWebSearch,
		preferRuntimeProviders: params.preferRuntimeProviders ?? true
	});
	if (candidates.length === 0) throw new Error("web_search is disabled or no provider is available.");
	const allowFallback = !hasExplicitWebSearchSelection({
		search,
		runtimeWebSearch,
		providerId: params.providerId,
		providers: candidates
	});
	let lastError;
	let sawUnavailableProvider = false;
	for (const candidate of candidates) try {
		const definition = candidate.createTool({
			config,
			agentDir: params.agentDir,
			searchConfig: search,
			runtimeMetadata: runtimeWebSearch
		});
		if (!definition) {
			if (!allowFallback) throw new Error(`web_search provider "${candidate.id}" is not available.`);
			sawUnavailableProvider = true;
			continue;
		}
		const executed = await definition.execute(params.args, { signal: params.signal });
		if (allowFallback && isStructuredAvailabilityError(executed)) {
			lastError = /* @__PURE__ */ new Error(`web_search provider "${candidate.id}" returned ${executed.error}`);
			continue;
		}
		return {
			provider: candidate.id,
			result: executed
		};
	} catch (error) {
		lastError = error;
		if (!allowFallback) throw error;
	}
	if (sawUnavailableProvider && lastError === void 0) throw new Error("web_search is enabled but no provider is currently available.");
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
//#endregion
export { runWebSearch as i, listConfiguredWebSearchProviders as n, listWebSearchProviders as r, isWebSearchProviderConfigured as t };
