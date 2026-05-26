import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { c as isRecord } from "./utils-sBTEdeml.js";
import { o as coerceSecretRef } from "./types.secrets-DwPik3M8.js";
import { s as resolveDefaultAgentDir } from "./agent-scope-config-CMp71_27.js";
import { n as ensureAuthProfileStore } from "./store-BMQkMM4l.js";
import { f as readNumberParam, g as readStringParam } from "./common-E9YpX7pB.js";
import { p as readProviderJsonObjectResponse } from "./provider-http-errors-C90BH-le.js";
import { a as wrapWebContent } from "./external-content-BWPoz0BU.js";
import { i as readCache, l as writeCache, o as resolveCacheTtlMs, r as normalizeCacheKey, s as resolveTimeoutSeconds } from "./web-shared-CYJpPo1M.js";
import { u as postTrustedWebToolsJson } from "./web-search-provider-common-Dg4Eh9ob.js";
import { a as listUsableProviderAuthProfileIds } from "./provider-auth-BtRKd5us.js";
import "./agent-runtime-Lc7H-PlR.js";
import { o as resolveApiKeyForProvider } from "./provider-auth-runtime-COV17c31.js";
import "./provider-http-CYBE-CBM.js";
import { i as resolveProviderWebSearchPluginConfig, r as mergeScopedSearchConfig, t as getScopedCredentialValue } from "./web-search-provider-config-CM5VNRaS.js";
import { n as resolveWebSearchProviderCredential } from "./provider-web-search-DNIStESL.js";
import { t as normalizeXaiModelId } from "./model-id-BRM_wbb3.js";
import "./tool-config-shared-Dk_VjbjJ.js";
import { n as setPluginXSearchConfigValue, t as resolveEffectiveXSearchConfig } from "./x-search-config-BhpqeUob.js";
import { a as requireXaiResponseTextCitationsAndInline, n as buildXaiResponsesToolBody, o as resolveXaiResponsesEndpoint, r as extractXaiWebSearchContent } from "./responses-tool-shared-Czzu3i8c.js";
import { t as XAI_DEFAULT_X_SEARCH_MODEL } from "./x-search-shared-DES161vI.js";
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
		return requireXaiResponseTextCitationsAndInline(await readProviderJsonObjectResponse(response, "xAI web search failed"), "xAI web search failed", params.inlineCitations);
	}).catch((error) => wrapXaiWebSearchError(error, params.timeoutSeconds));
}
//#endregion
//#region extensions/xai/src/web-search-provider.runtime.ts
const XAI_WEB_SEARCH_CACHE = /* @__PURE__ */ new Map();
const XAI_WEB_SEARCH_DEFAULT_TIMEOUT_SECONDS = 60;
const XAI_PROVIDER_ID = "xai";
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
		"It reuses the same xAI credential you configured for Grok web search.",
		`You can change this later with ${formatCliCommand("openclaw configure --section web")}.`
	].join("\n"), "X search");
	if (await ctx.prompter.select({
		message: "Enable x_search too?",
		options: [{
			value: "yes",
			label: "Yes, enable x_search",
			hint: "Search X posts with the same xAI credential"
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
function resolveConfiguredXaiWebSearchCredential(searchConfig) {
	return resolveWebSearchProviderCredential({
		credentialValue: getScopedCredentialValue(searchConfig, "grok"),
		path: "tools.web.search.grok.apiKey",
		envVars: []
	});
}
function hasConfiguredXaiWebSearchCredentialRef(searchConfig) {
	return coerceSecretRef(getScopedCredentialValue(searchConfig, "grok")) !== null;
}
async function resolveXaiProviderAuthCredential(params) {
	try {
		const config = params.config;
		const agentDir = params.agentDir?.trim() || (config ? resolveDefaultAgentDir(config) : void 0);
		const resolved = await resolveApiKeyForProvider({
			provider: XAI_PROVIDER_ID,
			cfg: config,
			...agentDir ? { agentDir } : {},
			...params.profileId ? {
				profileId: params.profileId,
				lockedProfile: true
			} : {},
			...params.forceRefresh ? { forceRefresh: true } : {},
			...params.credentialPrecedence ? { credentialPrecedence: params.credentialPrecedence } : {}
		});
		const apiKey = typeof resolved.apiKey === "string" ? resolved.apiKey.trim() : "";
		if (!apiKey) return;
		return {
			apiKey,
			mode: resolved.mode,
			...resolved.profileId ? { profileId: resolved.profileId } : {}
		};
	} catch {
		return;
	}
}
async function resolveXaiProviderApiKeyProfileFallback(params) {
	const config = params.config;
	const usableProfiles = listUsableProviderAuthProfileIds({
		agentDir: params.agentDir,
		cfg: config,
		provider: XAI_PROVIDER_ID
	});
	if (!usableProfiles.agentDir || usableProfiles.profileIds.length === 0) return;
	const store = ensureAuthProfileStore(usableProfiles.agentDir, { allowKeychainPrompt: false });
	for (const profileId of usableProfiles.profileIds) {
		const profile = store.profiles[profileId];
		if (!profile || profile.provider !== XAI_PROVIDER_ID || profile.type === "oauth") continue;
		const resolved = await resolveXaiProviderAuthCredential({
			agentDir: usableProfiles.agentDir,
			config: params.config,
			profileId
		});
		if (resolved?.apiKey && resolved.mode !== "oauth") return resolved;
	}
}
async function resolveXaiWebSearchAuth(ctx, searchConfig, options) {
	const providerAuth = await resolveXaiProviderAuthCredential({
		agentDir: ctx.agentDir,
		config: ctx.config,
		forceRefresh: options?.forceRefresh,
		profileId: options?.profileId
	});
	if (providerAuth?.mode === "oauth") return providerAuth;
	const configured = resolveConfiguredXaiWebSearchCredential(searchConfig);
	if (configured) return {
		apiKey: configured,
		mode: "api-key"
	};
	if (hasConfiguredXaiWebSearchCredentialRef(searchConfig)) return;
	return providerAuth;
}
async function resolveXaiWebSearchApiKeyFallback(ctx, searchConfig) {
	const configured = resolveConfiguredXaiWebSearchCredential(searchConfig);
	if (configured) return {
		apiKey: configured,
		mode: "api-key"
	};
	if (hasConfiguredXaiWebSearchCredentialRef(searchConfig)) return;
	const providerAuth = await resolveXaiProviderAuthCredential({
		agentDir: ctx.agentDir,
		config: ctx.config,
		credentialPrecedence: "env-first"
	});
	if (providerAuth?.apiKey && providerAuth.mode !== "oauth") return providerAuth;
	return await resolveXaiProviderApiKeyProfileFallback({
		agentDir: ctx.agentDir,
		config: ctx.config
	});
}
function isXaiUnauthorizedError(error) {
	return error instanceof Error && error.message.includes("xAI API error (401)");
}
function resolveXaiWebSearchTimeoutSeconds(searchConfig) {
	return resolveTimeoutSeconds(searchConfig?.timeoutSeconds, XAI_WEB_SEARCH_DEFAULT_TIMEOUT_SECONDS);
}
async function executeXaiWebSearchProviderTool(ctx, args) {
	const searchConfig = resolveXaiToolSearchConfig(ctx);
	const auth = await resolveXaiWebSearchAuth(ctx, searchConfig);
	if (!auth) return {
		error: "missing_xai_api_key",
		message: "web_search (grok) needs xAI credentials. Run `openclaw onboard --auth-choice xai-oauth` to sign in with Grok, run `openclaw onboard --auth-choice xai-api-key`, set `XAI_API_KEY` in the Gateway environment, or configure `plugins.entries.xai.config.webSearch.apiKey`. If you do not want to configure search credentials, use web_fetch for a specific URL or the browser tool for interactive pages.",
		docs: "https://docs.openclaw.ai/tools/web"
	};
	const query = readStringParam(args, "query", { required: true });
	readNumberParam(args, "count", { integer: true });
	const request = {
		query,
		model: resolveXaiWebSearchModel(searchConfig),
		endpoint: resolveXaiWebSearchEndpoint(searchConfig),
		timeoutSeconds: resolveXaiWebSearchTimeoutSeconds(searchConfig),
		inlineCitations: resolveXaiInlineCitations(searchConfig),
		cacheTtlMs: resolveCacheTtlMs(searchConfig?.cacheTtlMinutes, 15)
	};
	try {
		return await runXaiWebSearch({
			...request,
			apiKey: auth.apiKey
		});
	} catch (error) {
		if (!isXaiUnauthorizedError(error) || !auth.profileId) throw error;
		if (auth.mode === "oauth") {
			const refreshed = await resolveXaiWebSearchAuth(ctx, searchConfig, {
				forceRefresh: true,
				profileId: auth.profileId
			});
			if (refreshed?.apiKey && refreshed.apiKey !== auth.apiKey) return await runXaiWebSearch({
				...request,
				apiKey: refreshed.apiKey
			});
		}
		const fallback = await resolveXaiWebSearchApiKeyFallback(ctx, searchConfig);
		if (!fallback?.apiKey || fallback.apiKey === auth.apiKey) throw error;
		return await runXaiWebSearch({
			...request,
			apiKey: fallback.apiKey
		});
	}
}
const testing = {
	buildXaiWebSearchPayload,
	extractXaiWebSearchContent,
	resolveXaiToolSearchConfig,
	resolveXaiWebSearchAuth,
	resolveXaiInlineCitations,
	resolveXaiWebSearchCredential,
	resolveXaiWebSearchEndpoint,
	resolveXaiWebSearchModel,
	resolveXaiWebSearchTimeoutSeconds,
	requestXaiWebSearch
};
//#endregion
export { runXaiSearchProviderSetup as n, testing as r, executeXaiWebSearchProviderTool as t };
