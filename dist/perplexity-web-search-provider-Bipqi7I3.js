import { i as resolveProviderWebSearchPluginConfig, r as mergeScopedSearchConfig } from "./web-search-provider-config-CM5VNRaS.js";
import { o as resolvePerplexityWebSearchRuntimeMetadata, r as createPerplexityWebSearchProviderBase } from "./perplexity-web-search-provider.shared-Dgmwb0iq.js";
//#region extensions/perplexity/src/perplexity-web-search-provider.ts
let perplexityWebSearchRuntimePromise;
function loadPerplexityWebSearchRuntime() {
	perplexityWebSearchRuntimePromise ??= import("./perplexity-web-search-provider.runtime-BRGTzwt-.js");
	return perplexityWebSearchRuntimePromise;
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function createPerplexityParameters(transport) {
	const properties = {
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
		freshness: {
			type: "string",
			description: "Filter by time: 'day' (24h), 'week', 'month', or 'year'."
		}
	};
	if (transport !== "chat_completions") {
		properties.country = {
			type: "string",
			description: "Native Perplexity Search API only. 2-letter country code."
		};
		properties.language = {
			type: "string",
			description: "Native Perplexity Search API only. ISO 639-1 language code."
		};
		properties.date_after = {
			type: "string",
			description: "Native Perplexity Search API only. Only results published after this date (YYYY-MM-DD)."
		};
		properties.date_before = {
			type: "string",
			description: "Native Perplexity Search API only. Only results published before this date (YYYY-MM-DD)."
		};
		properties.domain_filter = {
			type: "array",
			items: { type: "string" },
			description: "Native Perplexity Search API only. Domain filter (max 20)."
		};
		properties.max_tokens = {
			type: "number",
			description: "Native Perplexity Search API only. Total content budget across all results.",
			minimum: 1,
			maximum: 1e6
		};
		properties.max_tokens_per_page = {
			type: "number",
			description: "Native Perplexity Search API only. Max tokens extracted per page.",
			minimum: 1
		};
	}
	return {
		type: "object",
		properties,
		required: ["query"]
	};
}
function hasPerplexityLegacyOverride(searchConfig) {
	const perplexity = isRecord(searchConfig?.perplexity) ? searchConfig.perplexity : void 0;
	return typeof perplexity?.baseUrl === "string" && perplexity.baseUrl.trim().length > 0 || typeof perplexity?.model === "string" && perplexity.model.trim().length > 0;
}
function createPerplexityToolDefinition(searchConfig, runtimeTransport) {
	const schemaTransport = runtimeTransport ?? (hasPerplexityLegacyOverride(searchConfig) ? "chat_completions" : void 0);
	return {
		description: schemaTransport === "chat_completions" ? "Search the web using Perplexity Sonar via Perplexity/OpenRouter chat completions. Returns AI-synthesized answers with citations from web-grounded search." : "Search the web using Perplexity. Runtime routing decides between native Search API and Sonar chat-completions compatibility. Structured filters are available on the native Search API path.",
		parameters: createPerplexityParameters(schemaTransport),
		execute: async (args) => {
			const { executePerplexitySearch } = await loadPerplexityWebSearchRuntime();
			return await executePerplexitySearch(args, searchConfig);
		}
	};
}
function createPerplexityWebSearchProvider() {
	return {
		...createPerplexityWebSearchProviderBase(),
		resolveRuntimeMetadata: resolvePerplexityWebSearchRuntimeMetadata,
		createTool: (ctx) => createPerplexityToolDefinition(mergeScopedSearchConfig(ctx.searchConfig, "perplexity", resolveProviderWebSearchPluginConfig(ctx.config, "perplexity")), ctx.runtimeMetadata?.perplexityTransport)
	};
}
//#endregion
export { createPerplexityWebSearchProvider as t };
