import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { i as resolveProviderWebSearchPluginConfig, r as mergeScopedSearchConfig } from "./web-search-provider-config-CM5VNRaS.js";
import { t as createBaseWebSearchProviderContractFields } from "./provider-web-search-contract-fields-DIG8SRmz.js";
//#region extensions/perplexity/src/perplexity-web-search-provider.shared.ts
const DEFAULT_PERPLEXITY_BASE_URL = "https://openrouter.ai/api/v1";
const PERPLEXITY_DIRECT_BASE_URL = "https://api.perplexity.ai";
const PERPLEXITY_CREDENTIAL_PATH = "plugins.entries.perplexity.config.webSearch.apiKey";
const PERPLEXITY_ONBOARDING_SCOPES = ["text-inference"];
const PERPLEXITY_KEY_PREFIXES = ["pplx-"];
const OPENROUTER_KEY_PREFIXES = ["sk-or-"];
function createPerplexityWebSearchProviderBase() {
	return {
		id: "perplexity",
		label: "Perplexity Search",
		hint: "Requires Perplexity API key or OpenRouter API key · structured results",
		onboardingScopes: [...PERPLEXITY_ONBOARDING_SCOPES],
		credentialLabel: "Perplexity API key",
		envVars: ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"],
		placeholder: "pplx-...",
		signupUrl: "https://www.perplexity.ai/settings/api",
		docsUrl: "https://docs.openclaw.ai/perplexity",
		autoDetectOrder: 50,
		credentialPath: PERPLEXITY_CREDENTIAL_PATH,
		...createBaseWebSearchProviderContractFields({
			credentialPath: PERPLEXITY_CREDENTIAL_PATH,
			searchCredential: {
				type: "scoped",
				scopeId: "perplexity"
			},
			configuredCredential: { pluginId: "perplexity" }
		})
	};
}
function resolvePerplexityWebSearchRuntimeMetadata(ctx) {
	return { perplexityTransport: resolvePerplexityRuntimeTransport({
		searchConfig: mergeScopedSearchConfig(ctx.searchConfig, "perplexity", resolveProviderWebSearchPluginConfig(ctx.config, "perplexity")),
		resolvedKey: ctx.resolvedCredential?.value,
		keySource: ctx.resolvedCredential?.source ?? "missing",
		fallbackEnvVar: ctx.resolvedCredential?.fallbackEnvVar
	}) };
}
function inferPerplexityBaseUrlFromApiKey(apiKey) {
	if (!apiKey) return;
	const normalized = normalizeLowercaseStringOrEmpty(apiKey);
	if (PERPLEXITY_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return "direct";
	if (OPENROUTER_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return "openrouter";
}
function isDirectPerplexityBaseUrl(baseUrl) {
	try {
		return normalizeLowercaseStringOrEmpty(new URL(baseUrl.trim()).hostname) === "api.perplexity.ai";
	} catch {
		return false;
	}
}
function resolvePerplexityRuntimeTransport(params) {
	const perplexity = params.searchConfig?.perplexity;
	const scoped = perplexity && typeof perplexity === "object" && !Array.isArray(perplexity) ? perplexity : void 0;
	const configuredBaseUrl = normalizeOptionalString(scoped?.baseUrl) ?? "";
	const configuredModel = normalizeOptionalString(scoped?.model) ?? "";
	const baseUrl = (() => {
		if (configuredBaseUrl) return configuredBaseUrl;
		if (params.keySource === "env") {
			if (params.fallbackEnvVar === "PERPLEXITY_API_KEY") return PERPLEXITY_DIRECT_BASE_URL;
			if (params.fallbackEnvVar === "OPENROUTER_API_KEY") return DEFAULT_PERPLEXITY_BASE_URL;
		}
		if ((params.keySource === "config" || params.keySource === "secretRef") && params.resolvedKey) return inferPerplexityBaseUrlFromApiKey(params.resolvedKey) === "openrouter" ? DEFAULT_PERPLEXITY_BASE_URL : PERPLEXITY_DIRECT_BASE_URL;
		return DEFAULT_PERPLEXITY_BASE_URL;
	})();
	return configuredBaseUrl || configuredModel || !isDirectPerplexityBaseUrl(baseUrl) ? "chat_completions" : "search_api";
}
//#endregion
export { isDirectPerplexityBaseUrl as a, inferPerplexityBaseUrlFromApiKey as i, PERPLEXITY_DIRECT_BASE_URL as n, resolvePerplexityWebSearchRuntimeMetadata as o, createPerplexityWebSearchProviderBase as r, DEFAULT_PERPLEXITY_BASE_URL as t };
