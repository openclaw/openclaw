import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { f as readNumberParam, g as readStringParam } from "./common-E9YpX7pB.js";
import { o as createProviderHttpError, p as readProviderJsonObjectResponse } from "./provider-http-errors-C90BH-le.js";
import { a as wrapWebContent } from "./external-content-BWPoz0BU.js";
import { a as buildUnsupportedSearchFilterResponse, b as withTrustedWebSearchEndpoint, d as readCachedSearchPayload, f as readConfiguredSecretString, g as resolveSearchTimeoutSeconds, h as resolveSearchCount, i as buildSearchCacheKey, m as resolveSearchCacheTtlMs, p as readProviderEnvValue, x as writeCachedSearchPayload } from "./web-search-provider-common-Dg4Eh9ob.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./provider-http-CYBE-CBM.js";
import { a as setProviderWebSearchPluginConfigValue, i as resolveProviderWebSearchPluginConfig, r as mergeScopedSearchConfig } from "./web-search-provider-config-CM5VNRaS.js";
import "./provider-web-search-DNIStESL.js";
import { n as MOONSHOT_CN_BASE_URL, o as isNativeMoonshotBaseUrl, r as MOONSHOT_DEFAULT_MODEL_ID, t as MOONSHOT_BASE_URL } from "./provider-catalog-0bGkrp95.js";
//#region extensions/moonshot/src/kimi-web-search-provider.runtime.ts
const DEFAULT_KIMI_BASE_URL = MOONSHOT_BASE_URL;
const DEFAULT_KIMI_SEARCH_MODEL = MOONSHOT_DEFAULT_MODEL_ID;
/** Models that require explicit thinking disablement for web search.
* Reasoning variants (kimi-k2-thinking, kimi-k2-thinking-turbo) are excluded
* because they default to thinking-enabled and disabling it would defeat their
* purpose; they are also unlikely to be used for web search. */
const KIMI_THINKING_MODELS = new Set(["kimi-k2.6", "kimi-k2.5"]);
const KIMI_WEB_SEARCH_TOOL = {
	type: "builtin_function",
	function: { name: "$web_search" }
};
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function throwMalformedKimiResponse() {
	throw new Error("Kimi API error: malformed JSON response");
}
function resolveKimiConfig(searchConfig) {
	const kimi = searchConfig?.kimi;
	return kimi && typeof kimi === "object" && !Array.isArray(kimi) ? kimi : {};
}
function resolveKimiApiKey(kimi) {
	return readConfiguredSecretString(kimi?.apiKey, "tools.web.search.kimi.apiKey") ?? readProviderEnvValue(["KIMI_API_KEY", "MOONSHOT_API_KEY"]);
}
function resolveKimiModel(kimi) {
	return (normalizeOptionalString(kimi?.model) ?? "") || DEFAULT_KIMI_SEARCH_MODEL;
}
function trimTrailingSlashes(url) {
	return url.replace(/\/+$/, "");
}
function resolveKimiBaseUrl(kimi, openClawConfig) {
	const explicitBaseUrl = normalizeOptionalString(kimi?.baseUrl) ?? "";
	if (explicitBaseUrl) return trimTrailingSlashes(explicitBaseUrl) || DEFAULT_KIMI_BASE_URL;
	const moonshotBaseUrl = openClawConfig?.models?.providers?.moonshot?.baseUrl;
	if (typeof moonshotBaseUrl === "string") {
		const normalizedMoonshotBaseUrl = trimTrailingSlashes(moonshotBaseUrl.trim());
		if (normalizedMoonshotBaseUrl && isNativeMoonshotBaseUrl(normalizedMoonshotBaseUrl)) return normalizedMoonshotBaseUrl;
	}
	return DEFAULT_KIMI_BASE_URL;
}
function extractKimiMessageText(message) {
	const content = message?.content?.trim();
	if (content) return content;
	return message?.reasoning_content?.trim() || void 0;
}
function extractKimiCitations(data) {
	const searchResults = data.search_results ?? [];
	if (!Array.isArray(searchResults)) throwMalformedKimiResponse();
	const citations = searchResults.map((entry) => isRecord(entry) && typeof entry.url === "string" ? entry.url.trim() : "").filter((url) => Boolean(url));
	const choices = data.choices ?? [];
	if (!Array.isArray(choices)) throwMalformedKimiResponse();
	const firstChoice = choices[0];
	const toolCalls = (firstChoice && isRecord(firstChoice.message) ? firstChoice.message : void 0)?.tool_calls ?? [];
	if (!Array.isArray(toolCalls)) throwMalformedKimiResponse();
	for (const toolCall of toolCalls) {
		if (!isRecord(toolCall) || !isRecord(toolCall.function)) continue;
		const rawArguments = toolCall.function.arguments;
		if (typeof rawArguments !== "string" || !rawArguments) continue;
		try {
			const parsed = JSON.parse(rawArguments);
			const parsedUrl = normalizeOptionalString(parsed.url);
			if (parsedUrl) citations.push(parsedUrl);
			for (const result of parsed.search_results ?? []) {
				const resultUrl = normalizeOptionalString(result.url);
				if (resultUrl) citations.push(resultUrl);
			}
		} catch {}
	}
	return [...new Set(citations)];
}
function hasKimiSearchResults(data) {
	const searchResults = data.search_results ?? [];
	if (!Array.isArray(searchResults)) throwMalformedKimiResponse();
	return searchResults.some((entry) => isRecord(entry) && (Boolean(normalizeOptionalString(entry.url)) || Boolean(normalizeOptionalString(entry.title)) || Boolean(normalizeOptionalString(entry.content))));
}
function extractKimiToolResultContent(toolCall) {
	const rawArguments = toolCall.function?.arguments;
	if (typeof rawArguments !== "string" || rawArguments.trim().length === 0) return;
	return rawArguments;
}
async function runKimiSearch(params) {
	const endpoint = `${params.baseUrl.trim().replace(/\/$/, "")}/chat/completions`;
	const messages = [{
		role: "user",
		content: params.query
	}];
	const collectedCitations = /* @__PURE__ */ new Set();
	let hasGroundingEvidence = false;
	for (let round = 0; round < 3; round += 1) {
		const next = await withTrustedWebSearchEndpoint({
			url: endpoint,
			timeoutSeconds: params.timeoutSeconds,
			init: {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${params.apiKey}`
				},
				body: JSON.stringify({
					model: params.model,
					...KIMI_THINKING_MODELS.has(params.model) ? { thinking: { type: "disabled" } } : {},
					messages,
					tools: [KIMI_WEB_SEARCH_TOOL]
				})
			}
		}, async (res) => {
			if (!res.ok) throw await createProviderHttpError(res, "Kimi API error");
			const data = await readProviderJsonObjectResponse(res, "Kimi API error");
			if (!Array.isArray(data.choices)) throwMalformedKimiResponse();
			if (hasKimiSearchResults(data)) hasGroundingEvidence = true;
			for (const citation of extractKimiCitations(data)) collectedCitations.add(citation);
			if (collectedCitations.size > 0) hasGroundingEvidence = true;
			const choice = data.choices?.[0];
			if (!isRecord(choice) || !isRecord(choice.message)) throwMalformedKimiResponse();
			const message = choice?.message;
			const text = extractKimiMessageText(message);
			const toolCalls = message?.tool_calls ?? [];
			if (!Array.isArray(toolCalls)) throwMalformedKimiResponse();
			if (choice?.finish_reason !== "tool_calls" || toolCalls.length === 0) {
				if (!text) throwMalformedKimiResponse();
				return {
					done: true,
					content: text,
					citations: [...collectedCitations]
				};
			}
			messages.push({
				role: "assistant",
				content: message?.content ?? "",
				...message?.reasoning_content ? { reasoning_content: message.reasoning_content } : {},
				tool_calls: toolCalls
			});
			let pushed = false;
			for (const toolCall of toolCalls) {
				const toolCallId = toolCall.id?.trim();
				const toolCallName = toolCall.function?.name?.trim();
				const toolContent = extractKimiToolResultContent(toolCall);
				if (!toolCallId || !toolCallName || !toolContent) continue;
				if (toolCallName === KIMI_WEB_SEARCH_TOOL.function.name) hasGroundingEvidence = true;
				pushed = true;
				messages.push({
					role: "tool",
					tool_call_id: toolCallId,
					name: toolCallName,
					content: toolContent
				});
			}
			if (!pushed) {
				if (!text) throwMalformedKimiResponse();
				return {
					done: true,
					content: text,
					citations: [...collectedCitations]
				};
			}
			return { done: false };
		});
		if (next.done) return {
			content: next.content,
			citations: next.citations,
			grounded: hasGroundingEvidence
		};
	}
	return {
		content: "Search completed but no final answer was produced.",
		citations: [...collectedCitations],
		grounded: hasGroundingEvidence
	};
}
async function executeKimiWebSearchProviderTool(ctx, args) {
	const searchConfig = mergeScopedSearchConfig(ctx.searchConfig, "kimi", resolveProviderWebSearchPluginConfig(ctx.config, "moonshot"));
	const unsupportedResponse = buildUnsupportedSearchFilterResponse(args, "kimi");
	if (unsupportedResponse) return unsupportedResponse;
	const kimiConfig = resolveKimiConfig(searchConfig);
	const apiKey = resolveKimiApiKey(kimiConfig);
	if (!apiKey) return {
		error: "missing_kimi_api_key",
		message: "web_search (kimi) needs a Moonshot API key. Set KIMI_API_KEY or MOONSHOT_API_KEY in the Gateway environment, or configure tools.web.search.kimi.apiKey. If you do not want to configure a search API key, use web_fetch for a specific URL or the browser tool for interactive pages.",
		docs: "https://docs.openclaw.ai/tools/web"
	};
	const query = readStringParam(args, "query", { required: true });
	const count = readNumberParam(args, "count", { integer: true }) ?? searchConfig?.maxResults ?? void 0;
	const model = resolveKimiModel(kimiConfig);
	const baseUrl = resolveKimiBaseUrl(kimiConfig, ctx.config);
	const cacheKey = buildSearchCacheKey([
		"kimi",
		query,
		resolveSearchCount(count, 5),
		baseUrl,
		model
	]);
	const cached = readCachedSearchPayload(cacheKey);
	if (cached) return cached;
	const start = Date.now();
	const result = await runKimiSearch({
		query,
		apiKey,
		baseUrl,
		model,
		timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig)
	});
	if (!result.grounded) return {
		error: "kimi_web_search_ungrounded",
		message: "Kimi returned a chat completion without native web-search grounding. Retry the query, switch to a structured provider such as Brave, or use web_fetch/browser for a specific URL.",
		query,
		provider: "kimi",
		model,
		docs: "https://docs.openclaw.ai/tools/kimi-search",
		tookMs: Date.now() - start
	};
	const payload = {
		query,
		provider: "kimi",
		model,
		tookMs: Date.now() - start,
		externalContent: {
			untrusted: true,
			source: "web_search",
			provider: "kimi",
			wrapped: true
		},
		content: wrapWebContent(result.content),
		citations: result.citations
	};
	writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
	return payload;
}
async function runKimiSearchProviderSetup(ctx) {
	const existingPluginConfig = resolveProviderWebSearchPluginConfig(ctx.config, "moonshot");
	const normalizedBaseUrl = (normalizeOptionalString(existingPluginConfig?.baseUrl) ?? "").replace(/\/+$/, "");
	const existingModel = normalizeOptionalString(existingPluginConfig?.model) ?? "";
	const isCustomBaseUrl = normalizedBaseUrl && !isNativeMoonshotBaseUrl(normalizedBaseUrl);
	const regionOptions = [];
	if (isCustomBaseUrl) regionOptions.push({
		value: normalizedBaseUrl,
		label: `Keep current (${normalizedBaseUrl})`,
		hint: "custom endpoint"
	});
	regionOptions.push({
		value: MOONSHOT_BASE_URL,
		label: "Moonshot API key (.ai)",
		hint: "api.moonshot.ai"
	}, {
		value: MOONSHOT_CN_BASE_URL,
		label: "Moonshot API key (.cn)",
		hint: "api.moonshot.cn"
	});
	const baseUrl = await ctx.prompter.select({
		message: "Kimi API region",
		options: regionOptions,
		initialValue: normalizedBaseUrl || "https://api.moonshot.ai/v1"
	});
	const currentModelLabel = existingModel ? `Keep current (moonshot/${existingModel})` : `Use default (moonshot/${DEFAULT_KIMI_SEARCH_MODEL})`;
	const modelChoice = await ctx.prompter.select({
		message: "Kimi web search model",
		options: [
			{
				value: "__keep__",
				label: currentModelLabel
			},
			{
				value: "__custom__",
				label: "Enter model manually"
			},
			{
				value: DEFAULT_KIMI_SEARCH_MODEL,
				label: `moonshot/${DEFAULT_KIMI_SEARCH_MODEL}`
			}
		],
		initialValue: "__keep__"
	});
	let model;
	if (modelChoice === "__keep__") model = existingModel || DEFAULT_KIMI_SEARCH_MODEL;
	else if (modelChoice === "__custom__") model = (await ctx.prompter.text({
		message: "Kimi model name",
		initialValue: existingModel || DEFAULT_KIMI_SEARCH_MODEL,
		placeholder: DEFAULT_KIMI_SEARCH_MODEL
	}))?.trim() || DEFAULT_KIMI_SEARCH_MODEL;
	else model = modelChoice;
	const next = { ...ctx.config };
	setProviderWebSearchPluginConfigValue(next, "moonshot", "baseUrl", baseUrl);
	setProviderWebSearchPluginConfigValue(next, "moonshot", "model", model);
	return next;
}
const testing = {
	resolveKimiApiKey,
	resolveKimiModel,
	resolveKimiBaseUrl,
	extractKimiCitations,
	hasKimiSearchResults,
	extractKimiToolResultContent
};
//#endregion
export { runKimiSearchProviderSetup as n, testing as r, executeKimiWebSearchProviderTool as t };
