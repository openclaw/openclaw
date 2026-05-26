import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { f as readNumberParam, g as readStringParam } from "./common-E9YpX7pB.js";
import { m as readProviderJsonResponse, o as createProviderHttpError, u as formatProviderHttpErrorMessage } from "./provider-http-errors-C90BH-le.js";
import { a as wrapWebContent } from "./external-content-BWPoz0BU.js";
import { _ as resolveSiteName, b as withTrustedWebSearchEndpoint, d as readCachedSearchPayload, f as readConfiguredSecretString, g as resolveSearchTimeoutSeconds, h as resolveSearchCount, i as buildSearchCacheKey, m as resolveSearchCacheTtlMs, p as readProviderEnvValue, x as writeCachedSearchPayload } from "./web-search-provider-common-Dg4Eh9ob.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./provider-http-CYBE-CBM.js";
import { i as resolveProviderWebSearchPluginConfig, r as mergeScopedSearchConfig } from "./web-search-provider-config-CM5VNRaS.js";
import "./provider-web-search-DNIStESL.js";
//#region extensions/minimax/src/minimax-web-search-provider.runtime.ts
const MINIMAX_SEARCH_ENDPOINT_GLOBAL = "https://api.minimax.io/v1/coding_plan/search";
const MINIMAX_SEARCH_ENDPOINT_CN = "https://api.minimaxi.com/v1/coding_plan/search";
const MINIMAX_TOKEN_PLAN_ENV_VARS = [
	"MINIMAX_CODE_PLAN_KEY",
	"MINIMAX_CODING_API_KEY",
	"MINIMAX_OAUTH_TOKEN"
];
function resolveMiniMaxApiKey(searchConfig) {
	return readConfiguredSecretString(searchConfig?.apiKey, "tools.web.search.apiKey") ?? readProviderEnvValue([...MINIMAX_TOKEN_PLAN_ENV_VARS, "MINIMAX_API_KEY"]);
}
function isMiniMaxCnHost(value) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return false;
	try {
		return new URL(trimmed).hostname.endsWith("minimaxi.com");
	} catch {
		return trimmed.includes("minimaxi.com");
	}
}
function resolveMiniMaxRegion(searchConfig, config) {
	const minimax = typeof searchConfig?.minimax === "object" && searchConfig.minimax !== null && !Array.isArray(searchConfig.minimax) ? searchConfig.minimax : void 0;
	const configuredRegion = typeof minimax?.region === "string" ? normalizeOptionalString(minimax.region) : void 0;
	if (configuredRegion) return configuredRegion === "cn" ? "cn" : "global";
	if (isMiniMaxCnHost(process.env.MINIMAX_API_HOST)) return "cn";
	const providers = (config?.models)?.providers;
	const minimaxProvider = providers?.minimax;
	const portalProvider = providers?.["minimax-portal"];
	const baseUrl = typeof minimaxProvider?.baseUrl === "string" ? minimaxProvider.baseUrl : "";
	const portalBaseUrl = typeof portalProvider?.baseUrl === "string" ? portalProvider.baseUrl : "";
	if (isMiniMaxCnHost(baseUrl) || isMiniMaxCnHost(portalBaseUrl)) return "cn";
	return "global";
}
function resolveMiniMaxEndpoint(searchConfig, config) {
	return resolveMiniMaxRegion(searchConfig, config) === "cn" ? MINIMAX_SEARCH_ENDPOINT_CN : MINIMAX_SEARCH_ENDPOINT_GLOBAL;
}
async function runMiniMaxSearch(params) {
	return withTrustedWebSearchEndpoint({
		url: params.endpoint,
		timeoutSeconds: params.timeoutSeconds,
		init: {
			method: "POST",
			headers: {
				Authorization: `Bearer ${params.apiKey}`,
				"Content-Type": "application/json",
				Accept: "application/json"
			},
			body: JSON.stringify({ q: params.query })
		}
	}, async (res) => {
		if (!res.ok) throw await createProviderHttpError(res, "MiniMax Search API error");
		const data = await readProviderJsonResponse(res, "MiniMax Search API error");
		if (data.base_resp?.status_code && data.base_resp.status_code !== 0) throw new Error(formatProviderHttpErrorMessage({
			label: "MiniMax Search API error",
			status: data.base_resp.status_code,
			detail: data.base_resp.status_msg || "unknown error"
		}));
		return {
			results: (Array.isArray(data.organic) ? data.organic : []).slice(0, params.count).map((entry) => {
				const title = entry.title ?? "";
				const url = entry.link ?? "";
				const snippet = entry.snippet ?? "";
				return {
					title: title ? wrapWebContent(title, "web_search") : "",
					url,
					description: snippet ? wrapWebContent(snippet, "web_search") : "",
					published: entry.date || void 0,
					siteName: resolveSiteName(url) || void 0
				};
			}),
			relatedSearches: Array.isArray(data.related_searches) ? data.related_searches.map((r) => r.query).filter((q) => typeof q === "string" && q.length > 0).map((q) => wrapWebContent(q, "web_search")) : void 0
		};
	});
}
function missingMiniMaxKeyPayload() {
	return {
		error: "missing_minimax_api_key",
		message: `web_search (minimax) needs a MiniMax Token Plan key or OAuth token. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set MINIMAX_CODE_PLAN_KEY, MINIMAX_CODING_API_KEY, MINIMAX_OAUTH_TOKEN, or MINIMAX_API_KEY in the Gateway environment.`,
		docs: "https://docs.openclaw.ai/tools/web"
	};
}
async function executeMiniMaxWebSearchProviderTool(ctx, args) {
	const searchConfig = mergeScopedSearchConfig(ctx.searchConfig, "minimax", resolveProviderWebSearchPluginConfig(ctx.config, "minimax"), { mirrorApiKeyToTopLevel: true });
	const config = ctx.config;
	const apiKey = resolveMiniMaxApiKey(searchConfig);
	if (!apiKey) return missingMiniMaxKeyPayload();
	const params = args;
	const query = readStringParam(params, "query", { required: true });
	const resolvedCount = resolveSearchCount(readNumberParam(params, "count", { integer: true }) ?? searchConfig?.maxResults ?? void 0, 5);
	const endpoint = resolveMiniMaxEndpoint(searchConfig, config);
	const cacheKey = buildSearchCacheKey([
		"minimax",
		endpoint,
		query,
		resolvedCount
	]);
	const cached = readCachedSearchPayload(cacheKey);
	if (cached) return cached;
	const start = Date.now();
	const timeoutSeconds = resolveSearchTimeoutSeconds(searchConfig);
	const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);
	const { results, relatedSearches } = await runMiniMaxSearch({
		query,
		count: resolvedCount,
		apiKey,
		endpoint,
		timeoutSeconds
	});
	const payload = {
		query,
		provider: "minimax",
		count: results.length,
		tookMs: Date.now() - start,
		externalContent: {
			untrusted: true,
			source: "web_search",
			provider: "minimax",
			wrapped: true
		},
		results
	};
	if (relatedSearches && relatedSearches.length > 0) payload.relatedSearches = relatedSearches;
	writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
	return payload;
}
const testing = {
	MINIMAX_SEARCH_ENDPOINT_GLOBAL,
	MINIMAX_SEARCH_ENDPOINT_CN,
	resolveMiniMaxApiKey,
	resolveMiniMaxEndpoint,
	resolveMiniMaxRegion,
	readMiniMaxSearchJsonResponse: readProviderJsonResponse
};
//#endregion
export { testing as n, executeMiniMaxWebSearchProviderTool as t };
