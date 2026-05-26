import { t as createBaseWebSearchProviderContractFields } from "./provider-web-search-contract-fields-DIG8SRmz.js";
//#region extensions/minimax/src/minimax-web-search-provider.ts
const MINIMAX_CREDENTIAL_PATH = "plugins.entries.minimax.config.webSearch.apiKey";
const MINIMAX_WEB_SEARCH_ENV_VARS = [...[
	"MINIMAX_CODE_PLAN_KEY",
	"MINIMAX_CODING_API_KEY",
	"MINIMAX_OAUTH_TOKEN"
], "MINIMAX_API_KEY"];
let miniMaxWebSearchRuntimePromise;
function loadMiniMaxWebSearchRuntime() {
	miniMaxWebSearchRuntimePromise ??= import("./minimax-web-search-provider.runtime-B2DO-yng.js");
	return miniMaxWebSearchRuntimePromise;
}
const MiniMaxSearchSchema = {
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
	}
};
function createMiniMaxWebSearchProvider() {
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
		credentialPath: MINIMAX_CREDENTIAL_PATH,
		...createBaseWebSearchProviderContractFields({
			credentialPath: MINIMAX_CREDENTIAL_PATH,
			searchCredential: { type: "top-level" },
			configuredCredential: { pluginId: "minimax" }
		}),
		createTool: (ctx) => ({
			description: "Search the web using MiniMax Search API. Returns titles, URLs, snippets, and related search suggestions.",
			parameters: MiniMaxSearchSchema,
			execute: async (args) => {
				const { executeMiniMaxWebSearchProviderTool } = await loadMiniMaxWebSearchRuntime();
				return await executeMiniMaxWebSearchProviderTool(ctx, args);
			}
		})
	};
}
//#endregion
export { createMiniMaxWebSearchProvider as t };
