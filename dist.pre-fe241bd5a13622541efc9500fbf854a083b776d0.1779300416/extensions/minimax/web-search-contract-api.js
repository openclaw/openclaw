import { t as createBaseWebSearchProviderContractFields } from "../../provider-web-search-contract-fields-DIG8SRmz.js";
//#region extensions/minimax/web-search-contract-api.ts
const MINIMAX_WEB_SEARCH_ENV_VARS = [...[
	"MINIMAX_CODE_PLAN_KEY",
	"MINIMAX_CODING_API_KEY",
	"MINIMAX_OAUTH_TOKEN"
], "MINIMAX_API_KEY"];
function createMiniMaxWebSearchProvider() {
	const credentialPath = "plugins.entries.minimax.config.webSearch.apiKey";
	return {
		id: "minimax",
		label: "MiniMax Search",
		hint: "Structured results via MiniMax Token Plan search API",
		onboardingScopes: ["text-inference"],
		credentialLabel: "MiniMax Token Plan key or OAuth token",
		envVars: [...MINIMAX_WEB_SEARCH_ENV_VARS],
		placeholder: "sk-cp-...",
		signupUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
		docsUrl: "https://docs.openclaw.ai/tools/minimax-search",
		autoDetectOrder: 15,
		credentialPath,
		...createBaseWebSearchProviderContractFields({
			credentialPath,
			searchCredential: { type: "top-level" },
			configuredCredential: { pluginId: "minimax" }
		}),
		createTool: () => null
	};
}
//#endregion
export { createMiniMaxWebSearchProvider };
