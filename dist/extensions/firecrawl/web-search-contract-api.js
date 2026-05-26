import { t as createWebSearchProviderContractFields } from "../../provider-web-search-contract-DRFQdeKY.js";
//#region extensions/firecrawl/web-search-contract-api.ts
function createFirecrawlWebSearchProvider() {
	const credentialPath = "plugins.entries.firecrawl.config.webSearch.apiKey";
	const fetchCredentialPath = "plugins.entries.firecrawl.config.webFetch.apiKey";
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
		credentialPath,
		...createWebSearchProviderContractFields({
			credentialPath,
			searchCredential: {
				type: "scoped",
				scopeId: "firecrawl"
			},
			configuredCredential: { pluginId: "firecrawl" },
			selectionPluginId: "firecrawl"
		}),
		getConfiguredCredentialFallback: (config) => {
			const apiKey = (config?.plugins?.entries?.firecrawl?.config)?.webFetch?.apiKey;
			return apiKey === void 0 ? void 0 : {
				path: fetchCredentialPath,
				value: apiKey
			};
		},
		createTool: () => null
	};
}
//#endregion
export { createFirecrawlWebSearchProvider };
