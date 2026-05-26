import { _ as readStringParam, p as readNumberParam } from "./common-V7-zd73S.js";
import "./param-readers-CEKHiUCI.js";
import { t as createDuckDuckGoWebSearchProviderBase } from "./ddg-search-provider.shared-DKxS5IJ6.js";
//#region extensions/duckduckgo/src/ddg-search-provider.ts
let duckDuckGoClientModulePromise;
function loadDuckDuckGoClientModule() {
	duckDuckGoClientModulePromise ??= import("./ddg-client-DS7XTml9.js");
	return duckDuckGoClientModulePromise;
}
const DuckDuckGoSearchSchema = {
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
		region: {
			type: "string",
			description: "Optional DuckDuckGo region code such as us-en, uk-en, or de-de."
		},
		safeSearch: {
			type: "string",
			description: "SafeSearch level: strict, moderate, or off."
		}
	},
	additionalProperties: false
};
function createDuckDuckGoWebSearchProvider() {
	return {
		...createDuckDuckGoWebSearchProviderBase(),
		createTool: (ctx) => ({
			description: "Search the web using DuckDuckGo. Returns titles, URLs, and snippets with no API key required.",
			parameters: DuckDuckGoSearchSchema,
			execute: async (args) => {
				const { runDuckDuckGoSearch } = await loadDuckDuckGoClientModule();
				return await runDuckDuckGoSearch({
					config: ctx.config,
					query: readStringParam(args, "query", { required: true }),
					count: readNumberParam(args, "count", { integer: true }),
					region: readStringParam(args, "region"),
					safeSearch: readStringParam(args, "safeSearch")
				});
			}
		})
	};
}
//#endregion
export { createDuckDuckGoWebSearchProvider as t };
