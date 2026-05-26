import { t as enablePluginInConfig } from "./enable-Cnmqb24T.js";
import "./provider-web-fetch-x70-KT3G.js";
import { i as runFirecrawlScrape } from "./firecrawl-client-Ct8udGz4.js";
import { t as FIRECRAWL_WEB_FETCH_PROVIDER_SHARED } from "./firecrawl-fetch-provider-shared-CIft9i2o.js";
//#region extensions/firecrawl/src/firecrawl-fetch-provider.ts
function createFirecrawlWebFetchProvider() {
	return {
		...FIRECRAWL_WEB_FETCH_PROVIDER_SHARED,
		applySelectionConfig: (config) => enablePluginInConfig(config, "firecrawl").config,
		createTool: ({ config }) => ({
			description: "Fetch a page using Firecrawl.",
			parameters: {},
			execute: async (args) => {
				const url = typeof args.url === "string" ? args.url : "";
				const extractMode = args.extractMode === "text" ? "text" : "markdown";
				const maxChars = typeof args.maxChars === "number" && Number.isFinite(args.maxChars) ? Math.floor(args.maxChars) : void 0;
				const proxy = args.proxy === "basic" || args.proxy === "stealth" || args.proxy === "auto" ? args.proxy : void 0;
				const storeInCache = typeof args.storeInCache === "boolean" ? args.storeInCache : void 0;
				return await runFirecrawlScrape({
					cfg: config,
					url,
					extractMode,
					maxChars,
					...proxy ? { proxy } : {},
					...storeInCache !== void 0 ? { storeInCache } : {}
				});
			}
		})
	};
}
//#endregion
export { createFirecrawlWebFetchProvider as t };
