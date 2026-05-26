import { i as resolveProviderWebSearchPluginConfig, r as mergeScopedSearchConfig } from "./web-search-provider-config-CM5VNRaS.js";
import { t as createBaseWebSearchProviderContractFields } from "./provider-web-search-contract-fields-DIG8SRmz.js";
import "./gemini-web-search-provider.shared-C9ZUloRt.js";
//#region extensions/google/src/gemini-web-search-provider.ts
const GEMINI_CREDENTIAL_PATH = "plugins.entries.google.config.webSearch.apiKey";
const GOOGLE_PROVIDER_CREDENTIAL_PATH = "models.providers.google.apiKey";
let geminiWebSearchRuntimePromise;
function loadGeminiWebSearchRuntime() {
	geminiWebSearchRuntimePromise ??= import("./gemini-web-search-provider.runtime.js");
	return geminiWebSearchRuntimePromise;
}
const GEMINI_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		query: {
			type: "string",
			description: "Search query string."
		},
		count: {
			type: "number",
			description: "Number of results to return (1-10).",
			minimum: 1,
			maximum: 10
		},
		country: {
			type: "string",
			description: "Not supported by Gemini."
		},
		language: {
			type: "string",
			description: "Not supported by Gemini."
		},
		freshness: {
			type: "string",
			description: "Limit Google Search grounding to recent results: day, week, month, or year."
		},
		date_after: {
			type: "string",
			description: "Only ground with results published after this date (YYYY-MM-DD)."
		},
		date_before: {
			type: "string",
			description: "Only ground with results published before this date (YYYY-MM-DD)."
		}
	},
	required: ["query"]
};
function createGeminiToolDefinition(searchConfig) {
	return {
		description: "Search the web using Gemini with Google Search grounding. Returns AI-synthesized answers with citations from Google Search.",
		parameters: GEMINI_TOOL_PARAMETERS,
		execute: async (args, context) => {
			const { executeGeminiSearch } = await loadGeminiWebSearchRuntime();
			return await executeGeminiSearch(args, searchConfig, context);
		}
	};
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function resolveGoogleModelProviderConfig(config) {
	const provider = config?.models?.providers?.google;
	return isRecord(provider) ? provider : void 0;
}
function getGoogleModelProviderCredentialFallback(config) {
	const provider = resolveGoogleModelProviderConfig(config);
	return provider && provider.apiKey !== void 0 ? {
		path: GOOGLE_PROVIDER_CREDENTIAL_PATH,
		value: provider.apiKey
	} : void 0;
}
function withGoogleModelProviderFallbacks(searchConfig, config) {
	const provider = resolveGoogleModelProviderConfig(config);
	if (!provider || provider.apiKey === void 0 && provider.baseUrl === void 0) return searchConfig;
	const gemini = isRecord(searchConfig?.gemini) ? { ...searchConfig.gemini } : {};
	const mergedSearchConfig = searchConfig ? { ...searchConfig } : {};
	if (provider.apiKey !== void 0) gemini.providerApiKey = provider.apiKey;
	if (provider.baseUrl !== void 0) gemini.providerBaseUrl = provider.baseUrl;
	return {
		...mergedSearchConfig,
		gemini
	};
}
function createGeminiWebSearchProvider() {
	return {
		id: "gemini",
		label: "Gemini (Google Search)",
		hint: "Requires Google Gemini API key · Google Search grounding",
		onboardingScopes: ["text-inference"],
		credentialLabel: "Google Gemini API key",
		envVars: ["GEMINI_API_KEY"],
		placeholder: "AIza...",
		signupUrl: "https://aistudio.google.com/apikey",
		docsUrl: "https://docs.openclaw.ai/tools/web",
		autoDetectOrder: 20,
		credentialPath: GEMINI_CREDENTIAL_PATH,
		...createBaseWebSearchProviderContractFields({
			credentialPath: GEMINI_CREDENTIAL_PATH,
			searchCredential: {
				type: "scoped",
				scopeId: "gemini"
			},
			configuredCredential: { pluginId: "google" }
		}),
		getConfiguredCredentialFallback: getGoogleModelProviderCredentialFallback,
		createTool: (ctx) => createGeminiToolDefinition(withGoogleModelProviderFallbacks(mergeScopedSearchConfig(ctx.searchConfig, "gemini", resolveProviderWebSearchPluginConfig(ctx.config, "google")), ctx.config))
	};
}
//#endregion
export { createGeminiWebSearchProvider as t };
