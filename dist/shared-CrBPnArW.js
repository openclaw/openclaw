import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./provider-model-shared-DtsPmvDx.js";
import "./provider-catalog-shared-BLp5nwNN.js";
import { a as OPENAI_RESPONSES_STREAM_HOOKS } from "./provider-stream-B32dNOmb.js";
import "./provider-stream-family-CGsj5YYd.js";
import { t as createOpenAINativeWebSearchWrapper } from "./native-web-search-XBLHz-uw.js";
import { t as buildOpenAIReplayPolicy } from "./replay-policy-Cidy3Dcf.js";
import { n as resolveOpenAIWebSocketSessionPolicy, t as resolveOpenAITransportTurnState } from "./transport-policy-WBv_n2Q-.js";
//#region extensions/openai/shared.ts
const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
function toOpenAIDataUrl(buffer, mimeType) {
	return `data:${mimeType};base64,${buffer.toString("base64")}`;
}
function resolveConfiguredOpenAIBaseUrl(cfg) {
	return normalizeOptionalString(cfg?.models?.providers?.openai?.baseUrl) ?? OPENAI_API_BASE_URL;
}
function hasSupportedOpenAIResponsesTransport(transport) {
	return transport === "auto" || transport === "sse" || transport === "websocket";
}
function defaultOpenAIResponsesExtraParams(extraParams, options) {
	const hasSupportedTransport = hasSupportedOpenAIResponsesTransport(extraParams?.transport);
	const defaultTransport = options?.transport ?? "auto";
	if (hasSupportedTransport) return extraParams;
	return {
		...extraParams,
		transport: defaultTransport
	};
}
const resolveOpenAIResponsesTransportTurnState = (ctx) => resolveOpenAITransportTurnState(ctx);
const resolveOpenAIResponsesWebSocketSessionPolicy = (ctx) => resolveOpenAIWebSocketSessionPolicy(ctx);
const wrapOpenAIResponsesStreamFn = OPENAI_RESPONSES_STREAM_HOOKS.wrapStreamFn;
const wrapOpenAIResponsesProviderStreamFn = (ctx) => createOpenAINativeWebSearchWrapper(wrapOpenAIResponsesStreamFn?.(ctx) ?? ctx.streamFn, { config: ctx.config });
function buildOpenAIResponsesProviderHooks(options) {
	return {
		buildReplayPolicy: buildOpenAIReplayPolicy,
		prepareExtraParams: (ctx) => defaultOpenAIResponsesExtraParams(ctx.extraParams, options),
		...OPENAI_RESPONSES_STREAM_HOOKS,
		wrapStreamFn: wrapOpenAIResponsesProviderStreamFn,
		resolveTransportTurnState: resolveOpenAIResponsesTransportTurnState,
		resolveWebSocketSessionPolicy: resolveOpenAIResponsesWebSocketSessionPolicy
	};
}
function buildOpenAISyntheticCatalogEntry(template, entry) {
	if (!template) return;
	return {
		...template,
		id: entry.id,
		name: entry.id,
		reasoning: entry.reasoning,
		input: [...entry.input],
		contextWindow: entry.contextWindow,
		...entry.contextTokens === void 0 ? {} : { contextTokens: entry.contextTokens },
		...entry.cost === void 0 ? {} : { cost: entry.cost }
	};
}
//#endregion
export { toOpenAIDataUrl as i, buildOpenAISyntheticCatalogEntry as n, resolveConfiguredOpenAIBaseUrl as r, buildOpenAIResponsesProviderHooks as t };
