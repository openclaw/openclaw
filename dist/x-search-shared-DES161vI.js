import { p as readProviderJsonObjectResponse } from "./provider-http-errors-C90BH-le.js";
import { a as wrapWebContent } from "./external-content-BWPoz0BU.js";
import { u as postTrustedWebToolsJson } from "./web-search-provider-common-Dg4Eh9ob.js";
import "./provider-http-CYBE-CBM.js";
import "./provider-web-search-DNIStESL.js";
import { n as resolveNormalizedXaiToolModel, r as resolvePositiveIntegerToolConfig, t as coerceXaiToolConfig } from "./tool-config-shared-Dk_VjbjJ.js";
import { a as requireXaiResponseTextCitationsAndInline, n as buildXaiResponsesToolBody, o as resolveXaiResponsesEndpoint } from "./responses-tool-shared-Czzu3i8c.js";
//#region extensions/xai/src/x-search-shared.ts
const XAI_DEFAULT_X_SEARCH_MODEL = "grok-4-1-fast-non-reasoning";
function resolveXaiXSearchConfig(config) {
	return coerceXaiToolConfig(config);
}
function resolveXaiXSearchModel(config) {
	return resolveNormalizedXaiToolModel({
		config,
		defaultModel: XAI_DEFAULT_X_SEARCH_MODEL
	});
}
function resolveXaiXSearchEndpoint(config) {
	return resolveXaiResponsesEndpoint(resolveXaiXSearchConfig(config).baseUrl);
}
function resolveXaiXSearchInlineCitations(config) {
	return resolveXaiXSearchConfig(config).inlineCitations === true;
}
function resolveXaiXSearchMaxTurns(config) {
	return resolvePositiveIntegerToolConfig(config, "maxTurns");
}
function buildXSearchTool(options) {
	return {
		type: "x_search",
		...options.allowedXHandles?.length ? { allowed_x_handles: options.allowedXHandles } : {},
		...options.excludedXHandles?.length ? { excluded_x_handles: options.excludedXHandles } : {},
		...options.fromDate ? { from_date: options.fromDate } : {},
		...options.toDate ? { to_date: options.toDate } : {},
		...options.enableImageUnderstanding ? { enable_image_understanding: true } : {},
		...options.enableVideoUnderstanding ? { enable_video_understanding: true } : {}
	};
}
function buildXaiXSearchPayload(params) {
	return {
		query: params.query,
		provider: "xai",
		model: params.model,
		tookMs: params.tookMs,
		externalContent: {
			untrusted: true,
			source: "x_search",
			provider: "xai",
			wrapped: true
		},
		content: wrapWebContent(params.content, "web_search"),
		citations: params.citations,
		...params.inlineCitations ? { inlineCitations: params.inlineCitations } : {},
		...params.options?.allowedXHandles?.length ? { allowedXHandles: params.options.allowedXHandles } : {},
		...params.options?.excludedXHandles?.length ? { excludedXHandles: params.options.excludedXHandles } : {},
		...params.options?.fromDate ? { fromDate: params.options.fromDate } : {},
		...params.options?.toDate ? { toDate: params.options.toDate } : {},
		...params.options?.enableImageUnderstanding ? { enableImageUnderstanding: true } : {},
		...params.options?.enableVideoUnderstanding ? { enableVideoUnderstanding: true } : {}
	};
}
async function requestXaiXSearch(params) {
	return await postTrustedWebToolsJson({
		url: params.endpoint,
		timeoutSeconds: params.timeoutSeconds,
		apiKey: params.apiKey,
		body: buildXaiResponsesToolBody({
			model: params.model,
			inputText: params.options.query,
			tools: [buildXSearchTool(params.options)],
			maxTurns: params.maxTurns
		}),
		errorLabel: "xAI"
	}, async (response) => {
		return requireXaiResponseTextCitationsAndInline(await readProviderJsonObjectResponse(response, "xAI X search failed"), "xAI X search failed", params.inlineCitations);
	});
}
//#endregion
export { resolveXaiXSearchInlineCitations as a, resolveXaiXSearchEndpoint as i, buildXaiXSearchPayload as n, resolveXaiXSearchMaxTurns as o, requestXaiXSearch as r, resolveXaiXSearchModel as s, XAI_DEFAULT_X_SEARCH_MODEL as t };
