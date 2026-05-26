import { t as createBaseWebSearchProviderContractFields } from "./provider-web-search-contract-fields-DIG8SRmz.js";
//#region extensions/moonshot/src/kimi-web-search-provider.ts
const KIMI_CREDENTIAL_PATH = "plugins.entries.moonshot.config.webSearch.apiKey";
let kimiWebSearchProviderRuntimePromise;
function loadKimiWebSearchProviderRuntime() {
	kimiWebSearchProviderRuntimePromise ??= import("./kimi-web-search-provider.runtime-4eIvX34P.js");
	return kimiWebSearchProviderRuntimePromise;
}
const KimiSearchSchema = {
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
		},
		country: {
			type: "string",
			description: "Not supported by Kimi."
		},
		language: {
			type: "string",
			description: "Not supported by Kimi."
		},
		freshness: {
			type: "string",
			description: "Not supported by Kimi."
		},
		date_after: {
			type: "string",
			description: "Not supported by Kimi."
		},
		date_before: {
			type: "string",
			description: "Not supported by Kimi."
		}
	}
};
async function runKimiSearchProviderSetup(ctx) {
	return await (await loadKimiWebSearchProviderRuntime()).runKimiSearchProviderSetup(ctx);
}
function createKimiWebSearchProvider() {
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
		credentialPath: KIMI_CREDENTIAL_PATH,
		...createBaseWebSearchProviderContractFields({
			credentialPath: KIMI_CREDENTIAL_PATH,
			searchCredential: {
				type: "scoped",
				scopeId: "kimi"
			},
			configuredCredential: { pluginId: "moonshot" }
		}),
		runSetup: runKimiSearchProviderSetup,
		createTool: (ctx) => ({
			description: "Search the web using Kimi by Moonshot. Returns AI-synthesized answers with citations from native $web_search.",
			parameters: KimiSearchSchema,
			execute: async (args) => {
				const { executeKimiWebSearchProviderTool } = await loadKimiWebSearchProviderRuntime();
				return await executeKimiWebSearchProviderTool(ctx, args);
			}
		})
	};
}
//#endregion
export { createKimiWebSearchProvider as t };
