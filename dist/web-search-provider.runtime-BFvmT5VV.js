import { t as formatCliCommand } from "./command-format-OwPqnbXG.js";
import { c as isRecord } from "./utils-CKsuXgDI.js";
import { _ as readStringParam, p as readNumberParam } from "./common-V7-zd73S.js";
import { a as wrapWebContent } from "./external-content-CjyYcKYs.js";
import { i as readCache, l as writeCache, o as resolveCacheTtlMs, r as normalizeCacheKey, s as resolveTimeoutSeconds } from "./web-shared-B-Y2uCeO.js";
import { u as postTrustedWebToolsJson } from "./web-search-provider-common-CHdvpLZ1.js";
import { i as resolveProviderWebSearchPluginConfig, r as mergeScopedSearchConfig, t as getScopedCredentialValue } from "./web-search-provider-config-BmnIzf0a.js";
import { n as resolveWebSearchProviderCredential } from "./provider-web-search-D2KY-StD.js";
import { t as normalizeXaiModelId } from "./model-id-BNFIY5AU.js";
import "./tool-config-shared-BNwC26dj.js";
import { n as setPluginXSearchConfigValue, t as resolveEffectiveXSearchConfig } from "./x-search-config-DjrZLBsF.js";
import { a as resolveXaiResponseTextCitationsAndInline, n as buildXaiResponsesToolBody, o as resolveXaiResponsesEndpoint, r as extractXaiWebSearchContent } from "./responses-tool-shared-C4oT2YLb.js";
import { t as XAI_DEFAULT_X_SEARCH_MODEL } from "./x-search-shared-D_Es9H21.js";
//#region extensions/xai/src/web-search-shared.ts
const XAI_DEFAULT_WEB_SEARCH_MODEL = "grok-4-1-fast";
function buildXaiWebSearchPayload(params) {
	return {
		query: params.query,
		provider: params.provider,
		model: params.model,
		tookMs: params.tookMs,
		externalContent: {
			untrusted: true,
			source: "web_search",
			provider: params.provider,
			wrapped: true
		},
		content: wrapWebContent(params.content, "web_search"),
		citations: params.citations,
		...params.inlineCitations ? { inlineCitations: params.inlineCitations } : {}
	};
}
function resolveXaiSearchConfig(searchConfig) {
	return (isRecord(searchConfig?.grok) ? searchConfig.grok : void 0) ?? {};
}
function resolveXaiWebSearchModel(searchConfig) {
	const config = resolveXaiSearchConfig(searchConfig);
	return typeof config.model === "string" && config.model.trim() ? normalizeXaiModelId(config.model.trim()) : XAI_DEFAULT_WEB_SEARCH_MODEL;
}
function resolveXaiWebSearchEndpoint(searchConfig) {
	return resolveXaiResponsesEndpoint(resolveXaiSearchConfig(searchConfig).baseUrl);
}
function resolveXaiInlineCitations(searchConfig) {
	return resolveXaiSearchConfig(searchConfig).inlineCitations === true;
}
function isAbortError(error) {
	return error instanceof Error && (error.name === "AbortError" || error.message === "This operation was aborted");
}
function wrapXaiWebSearchError(error, timeoutSeconds) {
	if (isAbortError(error)) throw new Error(`xAI web search timed out after ${timeoutSeconds}s. Increase tools.web.search.timeoutSeconds if queries are complex.`, { cause: error });
	throw error;
}
async function requestXaiWebSearch(params) {
	return await postTrustedWebToolsJson({
		url: params.endpoint,
		timeoutSeconds: params.timeoutSeconds,
		apiKey: params.apiKey,
		body: buildXaiResponsesToolBody({
			model: params.model,
			inputText: params.query,
			tools: [{ type: "web_search" }]
		}),
		errorLabel: "xAI"
	}, async (response) => {
		return resolveXaiResponseTextCitationsAndInline(await response.json(), params.inlineCitations);
	}).catch((error) => wrapXaiWebSearchError(error, params.timeoutSeconds));
}
//#endregion
//#region extensions/xai/src/web-search-provider.runtime.ts
const XAI_WEB_SEARCH_CACHE = /* @__PURE__ */ new Map();
const XAI_WEB_SEARCH_DEFAULT_TIMEOUT_SECONDS = 60;
const X_SEARCH_MODEL_OPTIONS = [{
	value: XAI_DEFAULT_X_SEARCH_MODEL,
	label: XAI_DEFAULT_X_SEARCH_MODEL,
	hint: "default · fast, no reasoning"
}, {
	value: "grok-4-1-fast",
	label: "grok-4-1-fast",
	hint: "fast with reasoning"
}];
function resolveXSearchConfigRecord(config) {
	return resolveEffectiveXSearchConfig(config);
}
async function runXaiSearchProviderSetup(ctx) {
	const existingXSearch = resolveXSearchConfigRecord(ctx.config);
	if (existingXSearch?.enabled === false) return ctx.config;
	await ctx.prompter.note([
		"x_search lets your agent search X (formerly Twitter) posts via xAI.",
		"It reuses the same xAI API key you just configured for Grok web search.",
		`You can change this later with ${formatCliCommand("openclaw configure --section web")}.`
	].join("\n"), "X search");
	if (await ctx.prompter.select({
		message: "Enable x_search too?",
		options: [{
			value: "yes",
			label: "Yes, enable x_search",
			hint: "Search X posts with the same xAI key"
		}, {
			value: "skip",
			label: "Skip for now",
			hint: "Keep Grok web_search only"
		}],
		initialValue: existingXSearch?.enabled === true || ctx.quickstartDefaults ? "yes" : "skip"
	}) === "skip") return ctx.config;
	const existingModel = typeof existingXSearch?.model === "string" && existingXSearch.model.trim() ? existingXSearch.model.trim() : "";
	const knownModel = X_SEARCH_MODEL_OPTIONS.find((entry) => entry.value === existingModel)?.value;
	const modelPick = await ctx.prompter.select({
		message: "Grok model for x_search",
		options: [...X_SEARCH_MODEL_OPTIONS, {
			value: "__custom__",
			label: "Enter custom model name",
			hint: ""
		}],
		initialValue: knownModel ?? "grok-4-1-fast-non-reasoning"
	});
	let model = modelPick;
	if (modelPick === "__custom__") model = (await ctx.prompter.text({
		message: "Custom Grok model name",
		initialValue: existingModel || "grok-4-1-fast-non-reasoning",
		placeholder: "grok-4-1-fast-non-reasoning"
	})).trim() || "grok-4-1-fast-non-reasoning";
	const next = structuredClone(ctx.config);
	setPluginXSearchConfigValue(next, "enabled", true);
	setPluginXSearchConfigValue(next, "model", model || "grok-4-1-fast-non-reasoning");
	return next;
}
function runXaiWebSearch(params) {
	const cacheKey = normalizeCacheKey(`grok:${params.endpoint}:${params.model}:${String(params.inlineCitations)}:${params.query}`);
	const cached = readCache(XAI_WEB_SEARCH_CACHE, cacheKey);
	if (cached) return Promise.resolve({
		...cached.value,
		cached: true
	});
	return (async () => {
		const startedAt = Date.now();
		const result = await requestXaiWebSearch({
			query: params.query,
			model: params.model,
			apiKey: params.apiKey,
			endpoint: params.endpoint,
			timeoutSeconds: params.timeoutSeconds,
			inlineCitations: params.inlineCitations
		});
		const payload = buildXaiWebSearchPayload({
			query: params.query,
			provider: "grok",
			model: params.model,
			tookMs: Date.now() - startedAt,
			content: result.content,
			citations: result.citations,
			inlineCitations: result.inlineCitations
		});
		writeCache(XAI_WEB_SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
		return payload;
	})();
}
function resolveXaiToolSearchConfig(ctx) {
	return mergeScopedSearchConfig(ctx.searchConfig, "grok", resolveProviderWebSearchPluginConfig(ctx.config, "xai"));
}
function resolveXaiWebSearchCredential(searchConfig) {
	return resolveWebSearchProviderCredential({
		credentialValue: getScopedCredentialValue(searchConfig, "grok"),
		path: "tools.web.search.grok.apiKey",
		envVars: ["XAI_API_KEY"]
	});
}
function resolveXaiWebSearchTimeoutSeconds(searchConfig) {
	return resolveTimeoutSeconds(searchConfig?.timeoutSeconds, XAI_WEB_SEARCH_DEFAULT_TIMEOUT_SECONDS);
}
async function executeXaiWebSearchProviderTool(ctx, args) {
	const searchConfig = resolveXaiToolSearchConfig(ctx);
	const apiKey = resolveXaiWebSearchCredential(searchConfig);
	if (!apiKey) return {
		error: "missing_xai_api_key",
		message: "web_search (grok) needs an xAI API key. Set XAI_API_KEY in the Gateway environment, or configure plugins.entries.xai.config.webSearch.apiKey. If you do not want to configure a search API key, use web_fetch for a specific URL or the browser tool for interactive pages.",
		docs: "https://docs.openclaw.ai/tools/web"
	};
	const query = readStringParam(args, "query", { required: true });
	readNumberParam(args, "count", { integer: true });
	return await runXaiWebSearch({
		query,
		model: resolveXaiWebSearchModel(searchConfig),
		endpoint: resolveXaiWebSearchEndpoint(searchConfig),
		apiKey,
		timeoutSeconds: resolveXaiWebSearchTimeoutSeconds(searchConfig),
		inlineCitations: resolveXaiInlineCitations(searchConfig),
		cacheTtlMs: resolveCacheTtlMs(searchConfig?.cacheTtlMinutes, 15)
	});
}
const __testing = {
	buildXaiWebSearchPayload,
	extractXaiWebSearchContent,
	resolveXaiToolSearchConfig,
	resolveXaiInlineCitations,
	resolveXaiWebSearchCredential,
	resolveXaiWebSearchEndpoint,
	resolveXaiWebSearchModel,
	resolveXaiWebSearchTimeoutSeconds,
	requestXaiWebSearch
};
//#endregion
export { executeXaiWebSearchProviderTool as n, runXaiSearchProviderSetup as r, __testing as t };
