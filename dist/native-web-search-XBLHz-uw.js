import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { i as streamWithPayloadPatch } from "./moonshot-thinking-stream-wrappers-D3FMTw1i.js";
import "./provider-stream-shared-jI_a6bxx.js";
import "./provider-model-shared-DtsPmvDx.js";
import { r as isOpenAIApiBaseUrl } from "./base-url-UKY1cn1G.js";
import { streamSimple } from "@earendil-works/pi-ai";
//#region extensions/openai/native-web-search.ts
const OPENAI_WEB_SEARCH_TOOL = { type: "web_search" };
function isRecord(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function isOpenAINativeWebSearchEligibleModel(model) {
	const provider = typeof model.provider === "string" ? model.provider : void 0;
	if (model.api !== "openai-responses" || !provider || normalizeProviderId(provider) !== "openai") return false;
	const baseUrl = typeof model.baseUrl === "string" ? model.baseUrl : void 0;
	return !baseUrl || isOpenAIApiBaseUrl(baseUrl);
}
function shouldUseOpenAINativeWebSearchProvider(config) {
	const provider = config?.tools?.web?.search?.provider;
	if (typeof provider !== "string") return true;
	const normalized = provider.trim().toLowerCase();
	return normalized === "" || normalized === "auto" || normalized === "openai";
}
function shouldEnableOpenAINativeWebSearch(params) {
	return params.config?.tools?.web?.search?.enabled !== false && shouldUseOpenAINativeWebSearchProvider(params.config) && isOpenAINativeWebSearchEligibleModel(params.model);
}
function isNativeWebSearchTool(tool) {
	return isRecord(tool) && tool.type === OPENAI_WEB_SEARCH_TOOL.type;
}
function isManagedWebSearchTool(tool) {
	return isRecord(tool) && tool.type === "function" && tool.name === OPENAI_WEB_SEARCH_TOOL.type;
}
function raiseMinimalReasoningForOpenAINativeWebSearch(payload) {
	const reasoning = payload.reasoning;
	if (!isRecord(reasoning) || reasoning.effort !== "minimal") return;
	reasoning.effort = "low";
}
function patchOpenAINativeWebSearchPayload(payload) {
	if (!isRecord(payload)) return "payload_not_object";
	const existingTools = Array.isArray(payload.tools) ? payload.tools : [];
	const filteredTools = existingTools.filter((tool) => !isManagedWebSearchTool(tool));
	if (filteredTools.some(isNativeWebSearchTool)) {
		if (filteredTools.length !== existingTools.length) payload.tools = filteredTools;
		raiseMinimalReasoningForOpenAINativeWebSearch(payload);
		return "native_tool_already_present";
	}
	payload.tools = [...filteredTools, OPENAI_WEB_SEARCH_TOOL];
	raiseMinimalReasoningForOpenAINativeWebSearch(payload);
	return "injected";
}
function createOpenAINativeWebSearchWrapper(baseStreamFn, params) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		if (!shouldEnableOpenAINativeWebSearch({
			config: params.config,
			model
		})) return underlying(model, context, options);
		return streamWithPayloadPatch(underlying, model, context, options, (payload) => {
			patchOpenAINativeWebSearchPayload(payload);
		});
	};
}
//#endregion
export { patchOpenAINativeWebSearchPayload as n, createOpenAINativeWebSearchWrapper as t };
