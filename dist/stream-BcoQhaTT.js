import { t as applyAnthropicEphemeralCacheControlMarkers } from "./anthropic-payload-policy-BdSt2Wgn.js";
import { i as streamWithPayloadPatch } from "./moonshot-thinking-stream-wrappers-DY0RTUKY.js";
import { i as COPILOT_INTEGRATION_ID, s as buildCopilotIdeHeaders } from "./provider-auth-D5QGE8z6.js";
import "./provider-stream-shared-BMzmRA_f.js";
import { n as rewriteCopilotResponsePayloadConnectionBoundIds } from "./connection-bound-ids-8i8TfAew.js";
//#region extensions/github-copilot/stream.ts
function containsCopilotContentType(value, type) {
	if (Array.isArray(value)) return value.some((item) => containsCopilotContentType(item, type));
	if (!value || typeof value !== "object") return false;
	const entry = value;
	return entry.type === type || containsCopilotContentType(entry.content, type);
}
function inferCopilotInitiator(messages) {
	const last = messages[messages.length - 1];
	if (!last) return "user";
	if (last.role === "user" && containsCopilotContentType(last.content, "tool_result")) return "agent";
	return last.role === "user" ? "user" : "agent";
}
function hasCopilotVisionInput(messages) {
	return messages.some((message) => {
		if (message.role === "user" && Array.isArray(message.content)) return message.content.some((item) => containsCopilotContentType(item, "image"));
		if (message.role === "toolResult" && Array.isArray(message.content)) return message.content.some((item) => containsCopilotContentType(item, "image"));
		return false;
	});
}
function buildCopilotDynamicHeaders(params) {
	return {
		...buildCopilotIdeHeaders(),
		"Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
		"Openai-Organization": "github-copilot",
		"x-initiator": inferCopilotInitiator(params.messages),
		...params.hasImages ? { "Copilot-Vision-Request": "true" } : {}
	};
}
function patchOnPayloadResult(result) {
	if (result && typeof result === "object" && "then" in result) return Promise.resolve(result).then((next) => {
		rewriteCopilotResponsePayloadConnectionBoundIds(next);
		return next;
	});
	rewriteCopilotResponsePayloadConnectionBoundIds(result);
	return result;
}
function buildCopilotRequestHeaders(context, headers) {
	return {
		...buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages: hasCopilotVisionInput(context.messages)
		}),
		...headers
	};
}
function wrapCopilotAnthropicStream(baseStreamFn) {
	if (!baseStreamFn) return;
	const underlying = baseStreamFn;
	return (model, context, options) => {
		if (model.provider !== "github-copilot" || model.api !== "anthropic-messages") return underlying(model, context, options);
		return streamWithPayloadPatch(underlying, model, context, {
			...options,
			headers: buildCopilotRequestHeaders(context, options?.headers)
		}, applyAnthropicEphemeralCacheControlMarkers);
	};
}
function wrapCopilotOpenAIResponsesStream(baseStreamFn) {
	if (!baseStreamFn) return;
	const underlying = baseStreamFn;
	return (model, context, options) => {
		if (model.provider !== "github-copilot" || model.api !== "openai-responses") return underlying(model, context, options);
		const originalOnPayload = options?.onPayload;
		return underlying(model, context, {
			...options,
			headers: buildCopilotRequestHeaders(context, options?.headers),
			onPayload: (payload, payloadModel) => {
				rewriteCopilotResponsePayloadConnectionBoundIds(payload);
				return patchOnPayloadResult(originalOnPayload?.(payload, payloadModel));
			}
		});
	};
}
function wrapCopilotProviderStream(ctx) {
	return wrapCopilotOpenAIResponsesStream(wrapCopilotAnthropicStream(ctx.streamFn));
}
//#endregion
export { wrapCopilotProviderStream as a, wrapCopilotOpenAIResponsesStream as i, hasCopilotVisionInput as n, wrapCopilotAnthropicStream as r, buildCopilotDynamicHeaders as t };
