import { t as createBaseWebSearchProviderContractFields } from "../../provider-web-search-contract-fields-DIG8SRmz.js";
//#region extensions/moonshot/web-search-contract-api.ts
function createKimiWebSearchProvider() {
	const credentialPath = "plugins.entries.moonshot.config.webSearch.apiKey";
	return {
		id: "kimi",
		label: "Kimi (Moonshot)",
		hint: "Requires Moonshot / Kimi API key · Moonshot web search",
		onboardingScopes: ["text-inference"],
		credentialLabel: "Moonshot / Kimi API key",
		envVars: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
		placeholder: "sk-...",
		signupUrl: "https://platform.moonshot.cn/",
		docsUrl: "https://docs.openclaw.ai/tools/web",
		autoDetectOrder: 40,
		credentialPath,
		...createBaseWebSearchProviderContractFields({
			credentialPath,
			searchCredential: {
				type: "scoped",
				scopeId: "kimi"
			},
			configuredCredential: { pluginId: "moonshot" }
		}),
		createTool: () => null
	};
}
//#endregion
export { createKimiWebSearchProvider };
