import { t as createWebSearchProviderContractFields } from "./provider-web-search-contract-DRFQdeKY.js";
//#region extensions/tavily/src/tavily-search-provider.ts
const TAVILY_CREDENTIAL_PATH = "plugins.entries.tavily.config.webSearch.apiKey";
let tavilyClientModulePromise;
function loadTavilyClientModule() {
	tavilyClientModulePromise ??= import("./tavily-client-97n7Clfi.js");
	return tavilyClientModulePromise;
}
const GenericTavilySearchSchema = {
	type: "object",
	properties: {
		query: {
			type: "string",
			description: "Search query string."
		},
		count: {
			type: "number",
			description: "Number of results to return (1-20).",
			minimum: 1,
			maximum: 20
		}
	},
	additionalProperties: false
};
function createTavilyWebSearchProvider() {
	return {
		id: "tavily",
		label: "Tavily Search",
		hint: "Structured results with domain filters and AI answer summaries",
		onboardingScopes: ["text-inference"],
		credentialLabel: "Tavily API key",
		envVars: ["TAVILY_API_KEY"],
		placeholder: "tvly-...",
		signupUrl: "https://tavily.com/",
		docsUrl: "https://docs.openclaw.ai/tools/tavily",
		autoDetectOrder: 70,
		credentialPath: TAVILY_CREDENTIAL_PATH,
		...createWebSearchProviderContractFields({
			credentialPath: TAVILY_CREDENTIAL_PATH,
			searchCredential: {
				type: "scoped",
				scopeId: "tavily"
			},
			configuredCredential: { pluginId: "tavily" },
			selectionPluginId: "tavily"
		}),
		createTool: (ctx) => ({
			description: "Search the web using Tavily. Returns structured results with snippets. Use tavily_search for Tavily-specific options like search depth, topic filtering, or AI answers.",
			parameters: GenericTavilySearchSchema,
			execute: async (args) => {
				const { runTavilySearch } = await loadTavilyClientModule();
				return await runTavilySearch({
					cfg: ctx.config,
					query: typeof args.query === "string" ? args.query : "",
					maxResults: typeof args.count === "number" ? args.count : void 0
				});
			}
		})
	};
}
//#endregion
export { createTavilyWebSearchProvider as t };
