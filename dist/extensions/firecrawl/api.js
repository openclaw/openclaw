import { f as readStringValue } from "../../string-coerce-DyL154ka.js";
import "../../string-coerce-runtime-BAEEbdFW.js";
import { r as runFirecrawlScrape } from "../../firecrawl-client-C_C8qfe7.js";
//#region extensions/firecrawl/api.ts
async function fetchFirecrawlContent(params) {
	const result = await runFirecrawlScrape({
		cfg: { plugins: { entries: { firecrawl: {
			enabled: true,
			config: { webFetch: {
				apiKey: params.apiKey,
				baseUrl: params.baseUrl,
				onlyMainContent: params.onlyMainContent,
				maxAgeMs: params.maxAgeMs,
				timeoutSeconds: params.timeoutSeconds
			} }
		} } } },
		url: params.url,
		extractMode: params.extractMode,
		maxChars: params.maxChars,
		proxy: params.proxy,
		storeInCache: params.storeInCache,
		onlyMainContent: params.onlyMainContent,
		maxAgeMs: params.maxAgeMs,
		timeoutSeconds: params.timeoutSeconds
	});
	return {
		text: typeof result.text === "string" ? result.text : "",
		title: readStringValue(result.title),
		finalUrl: readStringValue(result.finalUrl),
		status: typeof result.status === "number" ? result.status : void 0,
		warning: readStringValue(result.warning)
	};
}
//#endregion
export { fetchFirecrawlContent };
