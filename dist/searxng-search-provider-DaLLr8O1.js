import { _ as readStringParam, p as readNumberParam } from "./common-V7-zd73S.js";
import { t as createWebSearchProviderContractFields } from "./provider-web-search-contract-DsxDQUS3.js";
import "./param-readers-CEKHiUCI.js";
//#region extensions/searxng/src/searxng-search-provider.ts
const SEARXNG_CREDENTIAL_PATH = "plugins.entries.searxng.config.webSearch.baseUrl";
let searxngClientModulePromise;
function loadSearxngClientModule() {
	searxngClientModulePromise ??= import("./searxng-client-DYFgHFFK.js");
	return searxngClientModulePromise;
}
const SearxngSearchSchema = {
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
		categories: {
			type: "string",
			description: "Optional comma-separated search categories such as general, news, or science."
		},
		language: {
			type: "string",
			description: "Optional language code for results such as en, de, or fr."
		}
	},
	additionalProperties: false
};
function createSearxngWebSearchProvider() {
	return {
		id: "searxng",
		label: "SearXNG Search",
		hint: "Self-hosted meta-search with no API key required",
		onboardingScopes: ["text-inference"],
		requiresCredential: true,
		credentialLabel: "SearXNG Base URL",
		envVars: ["SEARXNG_BASE_URL"],
		placeholder: "http://localhost:8080",
		signupUrl: "https://docs.searxng.org/",
		autoDetectOrder: 200,
		credentialPath: SEARXNG_CREDENTIAL_PATH,
		...createWebSearchProviderContractFields({
			credentialPath: SEARXNG_CREDENTIAL_PATH,
			searchCredential: {
				type: "scoped",
				scopeId: "searxng"
			},
			configuredCredential: {
				pluginId: "searxng",
				field: "baseUrl"
			},
			selectionPluginId: "searxng"
		}),
		credentialNote: ["For the SearXNG JSON API to work, make sure your SearXNG instance", "has the json format enabled in its settings.yml under search.formats."].join("\n"),
		createTool: (ctx) => ({
			description: "Search the web using a self-hosted SearXNG instance. Returns titles, URLs, and snippets.",
			parameters: SearxngSearchSchema,
			execute: async (args) => {
				const { runSearxngSearch } = await loadSearxngClientModule();
				return await runSearxngSearch({
					config: ctx.config,
					query: readStringParam(args, "query", { required: true }),
					count: readNumberParam(args, "count", { integer: true }),
					categories: readStringParam(args, "categories"),
					language: readStringParam(args, "language")
				});
			}
		})
	};
}
//#endregion
export { createSearxngWebSearchProvider as t };
