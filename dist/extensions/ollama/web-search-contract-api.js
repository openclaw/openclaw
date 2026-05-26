import { t as createWebSearchProviderContractFields } from "../../provider-web-search-contract-DRFQdeKY.js";
//#region extensions/ollama/web-search-contract-api.ts
function createOllamaWebSearchProvider() {
	return {
		id: "ollama",
		label: "Ollama Web Search",
		hint: "Local Ollama host · requires ollama signin",
		onboardingScopes: ["text-inference"],
		requiresCredential: false,
		envVars: [],
		placeholder: "(run ollama signin)",
		signupUrl: "https://ollama.com/",
		docsUrl: "https://docs.openclaw.ai/tools/web",
		autoDetectOrder: 110,
		credentialPath: "",
		...createWebSearchProviderContractFields({
			credentialPath: "",
			searchCredential: { type: "none" },
			selectionPluginId: "ollama"
		}),
		createTool: () => null
	};
}
//#endregion
export { createOllamaWebSearchProvider };
