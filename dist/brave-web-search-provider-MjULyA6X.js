import { t as isDiagnosticFlagEnabled } from "./diagnostic-flags-Bss2g5Mq.js";
import { t as createBaseWebSearchProviderContractFields } from "./provider-web-search-contract-fields-DIG8SRmz.js";
//#region extensions/brave/src/brave-web-search-provider.ts
const BRAVE_CREDENTIAL_PATH = "plugins.entries.brave.config.webSearch.apiKey";
let braveWebSearchRuntimePromise;
function loadBraveWebSearchRuntime() {
	braveWebSearchRuntimePromise ??= import("./brave-web-search-provider.runtime.js");
	return braveWebSearchRuntimePromise;
}
const BraveSearchSchema = {
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
			description: "2-letter country code for region-specific results (e.g., 'DE', 'US', 'ALL'). Default: 'US'."
		},
		language: {
			type: "string",
			description: "ISO 639-1 language code for results (e.g., 'en', 'de', 'fr')."
		},
		freshness: {
			type: "string",
			description: "Filter by time: 'day' (24h), 'week', 'month', or 'year'."
		},
		date_after: {
			type: "string",
			description: "Only results published after this date (YYYY-MM-DD)."
		},
		date_before: {
			type: "string",
			description: "Only results published before this date (YYYY-MM-DD)."
		},
		search_lang: {
			type: "string",
			description: "Brave language code for search results (e.g., 'en', 'de', 'en-gb', 'zh-hans', 'zh-hant', 'pt-br')."
		},
		ui_lang: {
			type: "string",
			description: "Locale code for UI elements in language-region format (e.g., 'en-US', 'de-DE', 'fr-FR', 'tr-TR'). Must include region subtag."
		}
	}
};
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function resolveProviderWebSearchPluginConfig(config, pluginId) {
	if (!isRecord(config)) return;
	const plugins = isRecord(config.plugins) ? config.plugins : void 0;
	const entries = isRecord(plugins?.entries) ? plugins.entries : void 0;
	const entry = isRecord(entries?.[pluginId]) ? entries[pluginId] : void 0;
	const pluginConfig = isRecord(entry?.config) ? entry.config : void 0;
	return isRecord(pluginConfig?.webSearch) ? pluginConfig.webSearch : void 0;
}
function resolveLegacyTopLevelBraveCredential(config) {
	if (!isRecord(config)) return;
	const tools = isRecord(config.tools) ? config.tools : void 0;
	const web = isRecord(tools?.web) ? tools.web : void 0;
	const search = isRecord(web?.search) ? web.search : void 0;
	if (!search || !("apiKey" in search)) return;
	return {
		path: "tools.web.search.apiKey",
		value: search.apiKey
	};
}
function resolveConfiguredBraveCredential(config) {
	return resolveProviderWebSearchPluginConfig(config, "brave")?.apiKey ?? resolveLegacyTopLevelBraveCredential(config)?.value;
}
function mergeScopedSearchConfig(searchConfig, key, pluginConfig, options) {
	if (!pluginConfig) return searchConfig;
	const currentScoped = isRecord(searchConfig?.[key]) ? searchConfig?.[key] : {};
	const next = {
		...searchConfig,
		[key]: {
			...currentScoped,
			...pluginConfig
		}
	};
	if (options?.mirrorApiKeyToTopLevel && pluginConfig.apiKey !== void 0) next.apiKey = pluginConfig.apiKey;
	return next;
}
function resolveBraveMode(searchConfig) {
	return (isRecord(searchConfig?.brave) ? searchConfig.brave : void 0)?.mode === "llm-context" ? "llm-context" : "web";
}
function createBraveToolDefinition(searchConfig, config) {
	const braveMode = resolveBraveMode(searchConfig);
	const diagnosticsEnabled = isDiagnosticFlagEnabled("brave.http", config);
	return {
		description: braveMode === "llm-context" ? "Search the web using Brave Search LLM Context API. Returns pre-extracted page content (text chunks, tables, code blocks) optimized for LLM grounding." : "Search the web using Brave Search API. Supports region-specific and localized search via country and language parameters. Returns titles, URLs, and snippets for fast research.",
		parameters: BraveSearchSchema,
		execute: async (args) => {
			const { executeBraveSearch } = await loadBraveWebSearchRuntime();
			return await executeBraveSearch(args, searchConfig, { diagnosticsEnabled });
		}
	};
}
function createBraveWebSearchProvider() {
	return {
		id: "brave",
		label: "Brave Search",
		hint: "Structured results · country/language/time filters",
		onboardingScopes: ["text-inference"],
		credentialLabel: "Brave Search API key",
		envVars: ["BRAVE_API_KEY"],
		placeholder: "BSA...",
		signupUrl: "https://brave.com/search/api/",
		docsUrl: "https://docs.openclaw.ai/tools/brave-search",
		autoDetectOrder: 10,
		credentialPath: BRAVE_CREDENTIAL_PATH,
		...createBaseWebSearchProviderContractFields({
			credentialPath: BRAVE_CREDENTIAL_PATH,
			searchCredential: { type: "top-level" },
			configuredCredential: { pluginId: "brave" }
		}),
		getConfiguredCredentialValue: resolveConfiguredBraveCredential,
		getConfiguredCredentialFallback: resolveLegacyTopLevelBraveCredential,
		createTool: (ctx) => createBraveToolDefinition(mergeScopedSearchConfig(ctx.searchConfig, "brave", resolveProviderWebSearchPluginConfig(ctx.config, "brave"), { mirrorApiKeyToTopLevel: true }), ctx.config)
	};
}
//#endregion
export { createBraveWebSearchProvider as t };
