import { t as createBaseWebSearchProviderContractFields } from "./provider-web-search-contract-fields-b2TZwKc_.js";
//#region extensions/xai/web-search.ts
const XAI_CREDENTIAL_PATH = "plugins.entries.xai.config.webSearch.apiKey";
let xaiWebSearchProviderRuntimePromise;
function loadXaiWebSearchProviderRuntime() {
	xaiWebSearchProviderRuntimePromise ??= import("./web-search-provider.runtime-DfiDt3zC.js");
	return xaiWebSearchProviderRuntimePromise;
}
const GenericXaiSearchSchema = {
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
async function runXaiSearchProviderSetup(ctx) {
	return await (await loadXaiWebSearchProviderRuntime()).runXaiSearchProviderSetup(ctx);
}
function createXaiWebSearchProvider() {
	return {
		id: "grok",
		label: "Grok (xAI)",
		hint: "Requires xAI API key · xAI web-grounded responses",
		onboardingScopes: ["text-inference"],
		credentialLabel: "xAI API key",
		envVars: ["XAI_API_KEY"],
		placeholder: "xai-...",
		signupUrl: "https://console.x.ai/",
		docsUrl: "https://docs.openclaw.ai/tools/web",
		autoDetectOrder: 30,
		credentialPath: XAI_CREDENTIAL_PATH,
		...createBaseWebSearchProviderContractFields({
			credentialPath: XAI_CREDENTIAL_PATH,
			searchCredential: {
				type: "scoped",
				scopeId: "grok"
			},
			configuredCredential: { pluginId: "xai" }
		}),
		runSetup: runXaiSearchProviderSetup,
		createTool: (ctx) => ({
			description: "Search the web using xAI Grok. Returns AI-synthesized answers with citations from real-time web search.",
			parameters: GenericXaiSearchSchema,
			execute: async (args) => {
				const { executeXaiWebSearchProviderTool } = await loadXaiWebSearchProviderRuntime();
				return await executeXaiWebSearchProviderTool(ctx, args);
			}
		})
	};
}
//#endregion
export { createXaiWebSearchProvider as t };
