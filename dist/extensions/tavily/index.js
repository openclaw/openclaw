import { r as optionalStringEnum } from "../../typebox-CjEaoMel.js";
import { c as jsonResult, f as readNumberParam, g as readStringParam } from "../../common-E9YpX7pB.js";
import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import "../../channel-actions-DMN7G5RZ.js";
import "../../provider-web-search-DNIStESL.js";
import { n as runTavilySearch, t as runTavilyExtract } from "../../tavily-client-DDsyjm82.js";
import { t as createTavilyWebSearchProvider } from "../../tavily-search-provider-BTyAYEKb.js";
import { Type } from "typebox";
//#region extensions/tavily/src/tavily-extract-tool.ts
function resolveTavilyToolConfig$1(api, ctx) {
	return ctx?.getRuntimeConfig?.() ?? ctx?.runtimeConfig ?? ctx?.config ?? api.config;
}
const TavilyExtractToolSchema = Type.Object({
	urls: Type.Array(Type.String(), {
		description: "One or more URLs to extract content from (max 20).",
		minItems: 1,
		maxItems: 20
	}),
	query: Type.Optional(Type.String({ description: "Rerank extracted chunks by relevance to this query." })),
	extract_depth: optionalStringEnum(["basic", "advanced"], { description: "\"basic\" (default) or \"advanced\" (for JS-heavy pages)." }),
	chunks_per_source: Type.Optional(Type.Number({
		description: "Chunks per URL (1-5, requires query).",
		minimum: 1,
		maximum: 5
	})),
	include_images: Type.Optional(Type.Boolean({ description: "Include image URLs in extraction results." }))
}, { additionalProperties: false });
function createTavilyExtractTool(api, ctx) {
	return {
		name: "tavily_extract",
		label: "Tavily Extract",
		description: "Extract clean content from one or more URLs using Tavily. Handles JS-rendered pages. Supports query-focused chunking.",
		parameters: TavilyExtractToolSchema,
		execute: async (_toolCallId, rawParams) => {
			const urls = Array.isArray(rawParams.urls) ? rawParams.urls.filter(Boolean) : [];
			if (urls.length === 0) throw new Error("tavily_extract requires at least one URL.");
			const query = readStringParam(rawParams, "query") || void 0;
			const extractDepth = readStringParam(rawParams, "extract_depth") || void 0;
			const chunksPerSource = readNumberParam(rawParams, "chunks_per_source", { integer: true });
			if (chunksPerSource !== void 0 && !query) throw new Error("tavily_extract requires query when chunks_per_source is set.");
			const includeImages = rawParams.include_images === true;
			return jsonResult(await runTavilyExtract({
				cfg: resolveTavilyToolConfig$1(api, ctx),
				urls,
				query,
				extractDepth,
				chunksPerSource,
				includeImages
			}));
		}
	};
}
//#endregion
//#region extensions/tavily/src/tavily-search-tool.ts
function resolveTavilyToolConfig(api, ctx) {
	return ctx?.getRuntimeConfig?.() ?? ctx?.runtimeConfig ?? ctx?.config ?? api.config;
}
const TavilySearchToolSchema = Type.Object({
	query: Type.String({ description: "Search query string." }),
	search_depth: optionalStringEnum(["basic", "advanced"], { description: "Search depth: \"basic\" (default, faster) or \"advanced\" (more thorough)." }),
	topic: optionalStringEnum([
		"general",
		"news",
		"finance"
	], { description: "Search topic: \"general\" (default), \"news\", or \"finance\"." }),
	max_results: Type.Optional(Type.Number({
		description: "Number of results to return (1-20).",
		minimum: 1,
		maximum: 20
	})),
	include_answer: Type.Optional(Type.Boolean({ description: "Include an AI-generated answer summary (default: false)." })),
	time_range: optionalStringEnum([
		"day",
		"week",
		"month",
		"year"
	], { description: "Filter results by recency: 'day', 'week', 'month', or 'year'." }),
	include_domains: Type.Optional(Type.Array(Type.String(), { description: "Only include results from these domains." })),
	exclude_domains: Type.Optional(Type.Array(Type.String(), { description: "Exclude results from these domains." }))
}, { additionalProperties: false });
function createTavilySearchTool(api, ctx) {
	return {
		name: "tavily_search",
		label: "Tavily Search",
		description: "Search the web using Tavily Search API. Supports search depth, topic filtering, domain filters, time ranges, and AI answer summaries.",
		parameters: TavilySearchToolSchema,
		execute: async (_toolCallId, rawParams) => {
			const query = readStringParam(rawParams, "query", { required: true });
			const searchDepth = readStringParam(rawParams, "search_depth") || void 0;
			const topic = readStringParam(rawParams, "topic") || void 0;
			const maxResults = readNumberParam(rawParams, "max_results", { integer: true });
			const includeAnswer = rawParams.include_answer === true;
			const timeRange = readStringParam(rawParams, "time_range") || void 0;
			const includeDomains = Array.isArray(rawParams.include_domains) ? rawParams.include_domains.filter(Boolean) : void 0;
			const excludeDomains = Array.isArray(rawParams.exclude_domains) ? rawParams.exclude_domains.filter(Boolean) : void 0;
			return jsonResult(await runTavilySearch({
				cfg: resolveTavilyToolConfig(api, ctx),
				query,
				searchDepth,
				topic,
				maxResults,
				includeAnswer,
				timeRange,
				includeDomains: includeDomains?.length ? includeDomains : void 0,
				excludeDomains: excludeDomains?.length ? excludeDomains : void 0
			}));
		}
	};
}
//#endregion
//#region extensions/tavily/index.ts
var tavily_default = definePluginEntry({
	id: "tavily",
	name: "Tavily Plugin",
	description: "Bundled Tavily search and extract plugin",
	register(api) {
		api.registerWebSearchProvider(createTavilyWebSearchProvider());
		api.registerTool((ctx) => createTavilySearchTool(api, ctx), { name: "tavily_search" });
		api.registerTool((ctx) => createTavilyExtractTool(api, ctx), { name: "tavily_extract" });
	}
});
//#endregion
export { tavily_default as default };
