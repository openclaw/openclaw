import { t as createBaseWebSearchProviderContractFields } from "../../provider-web-search-contract-fields-DIG8SRmz.js";
//#region extensions/xai/web-search-contract-api.ts
function createXaiWebSearchProvider() {
	const credentialPath = "plugins.entries.xai.config.webSearch.apiKey";
	return {
		id: "grok",
		label: "Grok (xAI)",
		hint: "Uses xAI OAuth or API key · xAI web-grounded responses",
		onboardingScopes: ["text-inference"],
		credentialLabel: "xAI API key",
		envVars: ["XAI_API_KEY"],
		authProviderId: "xai",
		placeholder: "xai-...",
		signupUrl: "https://console.x.ai/",
		docsUrl: "https://docs.openclaw.ai/tools/web",
		autoDetectOrder: 30,
		credentialPath,
		...createBaseWebSearchProviderContractFields({
			credentialPath,
			searchCredential: {
				type: "scoped",
				scopeId: "grok"
			},
			configuredCredential: { pluginId: "xai" }
		}),
		createTool: () => null
	};
}
//#endregion
export { createXaiWebSearchProvider };
