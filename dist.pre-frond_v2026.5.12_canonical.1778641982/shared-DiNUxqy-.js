import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import "./provider-model-shared-BpwAf3yf.js";
import "./text-runtime-FOsx_CPC.js";
import "./provider-catalog-shared-Db90GZEt.js";
import { a as OPENAI_RESPONSES_STREAM_HOOKS } from "./provider-stream-C3_MB-2y.js";
import "./provider-stream-family-BQlx6kJx.js";
import { t as createOpenAINativeWebSearchWrapper } from "./native-web-search-BuZDNKqj.js";
import { t as buildOpenAIReplayPolicy } from "./replay-policy-9-KUReRt.js";
import { n as resolveOpenAIWebSocketSessionPolicy, t as resolveOpenAITransportTurnState } from "./transport-policy-_Br9gxdZ.js";
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
	const hasExplicitWarmup = typeof extraParams?.openaiWsWarmup === "boolean";
	const defaultTransport = options?.transport ?? "auto";
	const shouldDefaultWarmup = options?.openaiWsWarmup === true;
	if (hasSupportedTransport && (!shouldDefaultWarmup || hasExplicitWarmup)) return extraParams;
	return {
		...extraParams,
		...hasSupportedTransport ? {} : { transport: defaultTransport },
		...shouldDefaultWarmup && !hasExplicitWarmup ? { openaiWsWarmup: true } : {}
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
