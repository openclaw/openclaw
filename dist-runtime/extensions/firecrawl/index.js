import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import "../../logger-BOdgfoqz.js";
import "../../tmp-openclaw-dir-DgEKZnX6.js";
import "../../paths-CbmqEZIn.js";
import "../../subsystem-CsPxmH8p.js";
import "../../exec-CWMR162-.js";
import "../../logger-C833gw0R.js";
import { E as readStringParam, S as readNumberParam, b as jsonResult, w as readStringArrayParam } from "../../external-content-CxoN_TKD.js";
import "../../mime-33LCeGh-.js";
import { c as createFirecrawlWebSearchProvider, l as runFirecrawlScrape, r as optionalStringEnum, u as runFirecrawlSearch } from "../../typebox-B4kR5eyM.js";
import { Type } from "@sinclair/typebox";
//#region extensions/firecrawl/src/firecrawl-scrape-tool.ts
const FirecrawlScrapeToolSchema = Type.Object({
	url: Type.String({ description: "HTTP or HTTPS URL to scrape via Firecrawl." }),
	extractMode: optionalStringEnum(["markdown", "text"], { description: "Extraction mode (\"markdown\" or \"text\"). Default: markdown." }),
	maxChars: Type.Optional(Type.Number({
		description: "Maximum characters to return.",
		minimum: 100
	})),
	onlyMainContent: Type.Optional(Type.Boolean({ description: "Keep only main content when Firecrawl supports it." })),
	maxAgeMs: Type.Optional(Type.Number({
		description: "Maximum Firecrawl cache age in milliseconds.",
		minimum: 0
	})),
	proxy: optionalStringEnum([
		"auto",
		"basic",
		"stealth"
	], { description: "Firecrawl proxy mode (\"auto\", \"basic\", or \"stealth\")." }),
	storeInCache: Type.Optional(Type.Boolean({ description: "Whether Firecrawl should store the scrape in its cache." })),
	timeoutSeconds: Type.Optional(Type.Number({
		description: "Timeout in seconds for the Firecrawl scrape request.",
		minimum: 1
	}))
}, { additionalProperties: false });
function createFirecrawlScrapeTool(api) {
	return {
		name: "firecrawl_scrape",
		label: "Firecrawl Scrape",
		description: "Scrape a page using Firecrawl v2/scrape. Useful for JS-heavy or bot-protected pages where plain web_fetch is weak.",
		parameters: FirecrawlScrapeToolSchema,
		execute: async (_toolCallId, rawParams) => {
			const url = readStringParam(rawParams, "url", { required: true });
			const extractMode = readStringParam(rawParams, "extractMode") === "text" ? "text" : "markdown";
			const maxChars = readNumberParam(rawParams, "maxChars", { integer: true });
			const maxAgeMs = readNumberParam(rawParams, "maxAgeMs", { integer: true });
			const timeoutSeconds = readNumberParam(rawParams, "timeoutSeconds", { integer: true });
			const proxyRaw = readStringParam(rawParams, "proxy");
			const proxy = proxyRaw === "basic" || proxyRaw === "stealth" || proxyRaw === "auto" ? proxyRaw : void 0;
			const onlyMainContent = typeof rawParams.onlyMainContent === "boolean" ? rawParams.onlyMainContent : void 0;
			const storeInCache = typeof rawParams.storeInCache === "boolean" ? rawParams.storeInCache : void 0;
			return jsonResult(await runFirecrawlScrape({
				cfg: api.config,
				url,
				extractMode,
				maxChars,
				onlyMainContent,
				maxAgeMs,
				proxy,
				storeInCache,
				timeoutSeconds
			}));
		}
	};
}
//#endregion
//#region extensions/firecrawl/src/firecrawl-search-tool.ts
const FirecrawlSearchToolSchema = Type.Object({
	query: Type.String({ description: "Search query string." }),
	count: Type.Optional(Type.Number({
		description: "Number of results to return (1-10).",
		minimum: 1,
		maximum: 10
	})),
	sources: Type.Optional(Type.Array(Type.String(), { description: "Optional sources list, for example [\"web\"], [\"news\"], or [\"images\"]." })),
	categories: Type.Optional(Type.Array(Type.String(), { description: "Optional Firecrawl categories, for example [\"github\"] or [\"research\"]." })),
	scrapeResults: Type.Optional(Type.Boolean({ description: "Include scraped result content when Firecrawl returns it." })),
	timeoutSeconds: Type.Optional(Type.Number({
		description: "Timeout in seconds for the Firecrawl Search request.",
		minimum: 1
	}))
}, { additionalProperties: false });
function createFirecrawlSearchTool(api) {
	return {
		name: "firecrawl_search",
		label: "Firecrawl Search",
		description: "Search the web using Firecrawl v2/search. Can optionally include scraped content from result pages.",
		parameters: FirecrawlSearchToolSchema,
		execute: async (_toolCallId, rawParams) => {
			const query = readStringParam(rawParams, "query", { required: true });
			const count = readNumberParam(rawParams, "count", { integer: true });
			const timeoutSeconds = readNumberParam(rawParams, "timeoutSeconds", { integer: true });
			const sources = readStringArrayParam(rawParams, "sources");
			const categories = readStringArrayParam(rawParams, "categories");
			const scrapeResults = rawParams.scrapeResults === true;
			return jsonResult(await runFirecrawlSearch({
				cfg: api.config,
				query,
				count,
				timeoutSeconds,
				sources,
				categories,
				scrapeResults
			}));
		}
	};
}
//#endregion
//#region extensions/firecrawl/index.ts
const firecrawlPlugin = {
	id: "firecrawl",
	name: "Firecrawl Plugin",
	description: "Bundled Firecrawl search and scrape plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		api.registerWebSearchProvider(createFirecrawlWebSearchProvider());
		api.registerTool(createFirecrawlSearchTool(api));
		api.registerTool(createFirecrawlScrapeTool(api));
	}
};
//#endregion
export { firecrawlPlugin as default };
