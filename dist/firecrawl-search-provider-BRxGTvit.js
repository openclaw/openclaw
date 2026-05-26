import { t as createWebSearchProviderContractFields } from "./provider-web-search-contract-DRFQdeKY.js";
//#region extensions/firecrawl/src/firecrawl-search-provider.ts
const FIRECRAWL_CREDENTIAL_PATH = "plugins.entries.firecrawl.config.webSearch.apiKey";
const FIRECRAWL_FETCH_CREDENTIAL_PATH = "plugins.entries.firecrawl.config.webFetch.apiKey";
let firecrawlClientModulePromise;
function loadFirecrawlClientModule() {
	firecrawlClientModulePromise ??= import("./firecrawl-client-CrRPiLZB.js");
	return firecrawlClientModulePromise;
}
function getConfiguredFetchCredentialFallback(config) {
	const apiKey = (config?.plugins?.entries?.firecrawl?.config)?.webFetch?.apiKey;
	return apiKey === void 0 ? void 0 : {
		path: FIRECRAWL_FETCH_CREDENTIAL_PATH,
		value: apiKey
	};
}
const GenericFirecrawlSearchSchema = {
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
		}
	},
	additionalProperties: false
};
function createFirecrawlWebSearchProvider() {
	return {
		id: "firecrawl",
		label: "Firecrawl Search",
		hint: "Structured results with optional result scraping",
		onboardingScopes: ["text-inference"],
		credentialLabel: "Firecrawl API key",
		envVars: ["FIRECRAWL_API_KEY"],
		placeholder: "fc-...",
		signupUrl: "https://www.firecrawl.dev/",
		docsUrl: "https://docs.openclaw.ai/tools/firecrawl",
		autoDetectOrder: 60,
		credentialPath: FIRECRAWL_CREDENTIAL_PATH,
		...createWebSearchProviderContractFields({
			credentialPath: FIRECRAWL_CREDENTIAL_PATH,
			searchCredential: {
				type: "scoped",
				scopeId: "firecrawl"
			},
			configuredCredential: { pluginId: "firecrawl" },
			selectionPluginId: "firecrawl"
		}),
		getConfiguredCredentialFallback: getConfiguredFetchCredentialFallback,
		createTool: (ctx) => ({
			description: "Search the web using Firecrawl. Returns structured results with snippets from Firecrawl Search. Use firecrawl_search for Firecrawl-specific knobs like sources or categories.",
			parameters: GenericFirecrawlSearchSchema,
			execute: async (args) => {
				const { runFirecrawlSearch } = await loadFirecrawlClientModule();
				return await runFirecrawlSearch({
					cfg: ctx.config,
					query: typeof args.query === "string" ? args.query : "",
					count: typeof args.count === "number" ? args.count : void 0
				});
			}
		})
	};
}
//#endregion
export { createFirecrawlWebSearchProvider as t };
