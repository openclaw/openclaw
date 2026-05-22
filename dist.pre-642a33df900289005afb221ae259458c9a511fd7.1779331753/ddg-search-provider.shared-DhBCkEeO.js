import { t as createWebSearchProviderContractFields } from "./provider-web-search-contract-DRFQdeKY.js";
//#region extensions/duckduckgo/src/ddg-search-provider.shared.ts
const DUCKDUCKGO_ONBOARDING_SCOPES = ["text-inference"];
function createDuckDuckGoWebSearchProviderBase() {
	return {
		id: "duckduckgo",
		label: "DuckDuckGo Search (experimental)",
		hint: "Free web search fallback with no API key required",
		onboardingScopes: [...DUCKDUCKGO_ONBOARDING_SCOPES],
		requiresCredential: false,
		envVars: [],
		placeholder: "(no key needed)",
		signupUrl: "https://duckduckgo.com/",
		docsUrl: "https://docs.openclaw.ai/tools/web",
		autoDetectOrder: 100,
		credentialPath: "",
		...createWebSearchProviderContractFields({
			credentialPath: "",
			searchCredential: {
				type: "scoped",
				scopeId: "duckduckgo"
			},
			selectionPluginId: "duckduckgo"
		})
	};
}
//#endregion
export { createDuckDuckGoWebSearchProviderBase as t };
