import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { r as logVerbose } from "./globals-YU5FjfZK.js";
import { n as getActiveRuntimeWebToolsMetadata } from "./runtime-web-tools-state-BgXXPpNN.js";
import { o as sortWebFetchProvidersForAutoDetect } from "./web-search-providers.shared-C_XvZwgr.js";
import { n as resolveRuntimeWebFetchProviders, t as resolvePluginWebFetchProviders } from "./web-fetch-providers.runtime.js";
import { a as resolveWebProviderDefinition, i as resolveWebProviderConfig, n as providerRequiresCredential, r as readWebProviderEnvValue, t as hasWebProviderEntryCredential } from "./provider-runtime-shared-B1Ic1Utb.js";
//#region src/web-fetch/runtime.ts
function resolveWebFetchEnabled(params) {
	if (typeof params.fetch?.enabled === "boolean") return params.fetch.enabled;
	return true;
}
function resolveFetchConfig(config) {
	return resolveWebProviderConfig(config, "fetch");
}
function hasEntryCredential(provider, config, fetch) {
	return hasWebProviderEntryCredential({
		provider,
		config,
		toolConfig: fetch,
		resolveRawValue: ({ provider: currentProvider, config: currentConfig, toolConfig }) => currentProvider.getConfiguredCredentialValue?.(currentConfig) ?? currentProvider.getCredentialValue(toolConfig),
		resolveFallbackRawValue: ({ provider: currentProvider, config: currentConfig }) => currentProvider.getConfiguredCredentialFallback?.(currentConfig)?.value,
		resolveEnvValue: ({ provider: currentProvider }) => readWebProviderEnvValue(currentProvider.envVars)
	});
}
function isWebFetchProviderConfigured(params) {
	return hasEntryCredential(params.provider, params.config, resolveFetchConfig(params.config));
}
function listWebFetchProviders(params) {
	return resolvePluginWebFetchProviders({
		config: params?.config,
		bundledAllowlistCompat: true
	});
}
function listConfiguredWebFetchProviders(params) {
	return resolvePluginWebFetchProviders({
		config: params?.config,
		bundledAllowlistCompat: true
	});
}
function resolveWebFetchProviderId(params) {
	const providers = sortWebFetchProvidersForAutoDetect(params.providers ?? resolvePluginWebFetchProviders({
		config: params.config,
		bundledAllowlistCompat: true
	}));
	const raw = params.fetch && "provider" in params.fetch ? normalizeLowercaseStringOrEmpty(params.fetch.provider) : "";
	if (raw) {
		const explicit = providers.find((provider) => provider.id === raw);
		if (explicit) return explicit.id;
	}
	for (const provider of providers) {
		if (!providerRequiresCredential(provider)) {
			logVerbose(`web_fetch: ${raw ? `invalid configured provider "${raw}", ` : ""}auto-detected keyless provider "${provider.id}"`);
			return provider.id;
		}
		if (!hasEntryCredential(provider, params.config, params.fetch)) continue;
		logVerbose(`web_fetch: ${raw ? `invalid configured provider "${raw}", ` : ""}auto-detected "${provider.id}" from available API keys`);
		return provider.id;
	}
	return "";
}
function resolveConfiguredWebFetchProviderId(params) {
	const raw = params.fetch && "provider" in params.fetch ? normalizeLowercaseStringOrEmpty(params.fetch.provider) : "";
	if (!raw) return;
	return params.providers.find((provider) => provider.id === raw)?.id;
}
function resolveWebFetchDefinition(options) {
	const fetch = resolveWebProviderConfig(options?.config, "fetch");
	const runtimeWebFetch = options?.runtimeWebFetch ?? getActiveRuntimeWebToolsMetadata()?.fetch;
	const providers = sortWebFetchProvidersForAutoDetect(options?.sandboxed ? resolvePluginWebFetchProviders({
		config: options?.config,
		bundledAllowlistCompat: true,
		origin: "bundled"
	}) : options?.preferRuntimeProviders ? resolveRuntimeWebFetchProviders({
		config: options?.config,
		bundledAllowlistCompat: true
	}) : resolvePluginWebFetchProviders({
		config: options?.config,
		bundledAllowlistCompat: true
	}));
	return resolveWebProviderDefinition({
		config: options?.config,
		toolConfig: fetch,
		runtimeMetadata: runtimeWebFetch,
		sandboxed: options?.sandboxed,
		providerId: options?.providerId ?? resolveConfiguredWebFetchProviderId({
			fetch,
			providers
		}),
		providers,
		resolveEnabled: ({ toolConfig, sandboxed }) => resolveWebFetchEnabled({
			fetch: toolConfig,
			sandboxed
		}),
		resolveAutoProviderId: ({ config, toolConfig, providers }) => resolveWebFetchProviderId({
			config,
			fetch: toolConfig,
			providers
		}),
		createTool: ({ provider, config, toolConfig, runtimeMetadata }) => provider.createTool({
			config,
			fetchConfig: toolConfig,
			runtimeMetadata
		})
	});
}
//#endregion
export { resolveWebFetchEnabled as a, resolveWebFetchDefinition as i, listConfiguredWebFetchProviders as n, resolveWebFetchProviderId as o, listWebFetchProviders as r, isWebFetchProviderConfigured as t };
