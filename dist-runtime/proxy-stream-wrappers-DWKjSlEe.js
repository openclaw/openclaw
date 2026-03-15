import { streamSimple } from "@mariozechner/pi-ai";
//#region src/agents/pi-embedded-runner/proxy-stream-wrappers.ts
const OPENROUTER_APP_HEADERS = {
	"HTTP-Referer": "https://openclaw.ai",
	"X-Title": "OpenClaw"
};
const KILOCODE_FEATURE_HEADER = "X-KILOCODE-FEATURE";
const KILOCODE_FEATURE_DEFAULT = "openclaw";
const KILOCODE_FEATURE_ENV_VAR = "KILOCODE_FEATURE";
function resolveKilocodeAppHeaders() {
	const feature = process.env[KILOCODE_FEATURE_ENV_VAR]?.trim() || KILOCODE_FEATURE_DEFAULT;
	return { [KILOCODE_FEATURE_HEADER]: feature };
}
function isOpenRouterAnthropicModel(provider, modelId) {
	return provider.toLowerCase() === "openrouter" && modelId.toLowerCase().startsWith("anthropic/");
}
function mapThinkingLevelToOpenRouterReasoningEffort(thinkingLevel) {
	if (thinkingLevel === "off") {return "none";}
	if (thinkingLevel === "adaptive") {return "medium";}
	return thinkingLevel;
}
function normalizeProxyReasoningPayload(payload, thinkingLevel) {
	if (!payload || typeof payload !== "object") {return;}
	const payloadObj = payload;
	delete payloadObj.reasoning_effort;
	if (!thinkingLevel || thinkingLevel === "off") {return;}
	const existingReasoning = payloadObj.reasoning;
	if (existingReasoning && typeof existingReasoning === "object" && !Array.isArray(existingReasoning)) {
		const reasoningObj = existingReasoning;
		if (!("max_tokens" in reasoningObj) && !("effort" in reasoningObj)) {reasoningObj.effort = mapThinkingLevelToOpenRouterReasoningEffort(thinkingLevel);}
	} else if (!existingReasoning) {payloadObj.reasoning = { effort: mapThinkingLevelToOpenRouterReasoningEffort(thinkingLevel) };}
}
function createOpenRouterSystemCacheWrapper(baseStreamFn) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		if (typeof model.provider !== "string" || typeof model.id !== "string" || !isOpenRouterAnthropicModel(model.provider, model.id)) {return underlying(model, context, options);}
		const originalOnPayload = options?.onPayload;
		return underlying(model, context, {
			...options,
			onPayload: (payload) => {
				const messages = payload?.messages;
				if (Array.isArray(messages)) {for (const msg of messages) {
					if (msg.role !== "system" && msg.role !== "developer") continue;
					if (typeof msg.content === "string") msg.content = [{
						type: "text",
						text: msg.content,
						cache_control: { type: "ephemeral" }
					}];
					else if (Array.isArray(msg.content) && msg.content.length > 0) {
						const last = msg.content[msg.content.length - 1];
						if (last && typeof last === "object") last.cache_control = { type: "ephemeral" };
					}
				}}
				return originalOnPayload?.(payload, model);
			}
		});
	};
}
function createOpenRouterWrapper(baseStreamFn, thinkingLevel) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		const onPayload = options?.onPayload;
		return underlying(model, context, {
			...options,
			headers: {
				...OPENROUTER_APP_HEADERS,
				...options?.headers
			},
			onPayload: (payload) => {
				normalizeProxyReasoningPayload(payload, thinkingLevel);
				return onPayload?.(payload, model);
			}
		});
	};
}
function isProxyReasoningUnsupported(modelId) {
	return modelId.toLowerCase().startsWith("x-ai/");
}
function createKilocodeWrapper(baseStreamFn, thinkingLevel) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => {
		const onPayload = options?.onPayload;
		return underlying(model, context, {
			...options,
			headers: {
				...options?.headers,
				...resolveKilocodeAppHeaders()
			},
			onPayload: (payload) => {
				normalizeProxyReasoningPayload(payload, thinkingLevel);
				return onPayload?.(payload, model);
			}
		});
	};
}
//#endregion
export { isProxyReasoningUnsupported as i, createOpenRouterSystemCacheWrapper as n, createOpenRouterWrapper as r, createKilocodeWrapper as t };
