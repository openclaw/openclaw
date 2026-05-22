import { t as applyAnthropicEphemeralCacheControlMarkers } from "./anthropic-payload-policy-ae4lN_wa.js";
import { g as streamWithPayloadPatch } from "./provider-model-shared-DseRItUT.js";
import { n as hasCopilotVisionInput, t as buildCopilotDynamicHeaders } from "./copilot-dynamic-headers-CqHJnvVM.js";
import "./provider-stream-shared-DPCP2aNX.js";
import { n as rewriteCopilotResponsePayloadConnectionBoundIds } from "./connection-bound-ids-BC05DRv5.js";
//#region extensions/github-copilot/stream.ts
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
export { wrapCopilotOpenAIResponsesStream as n, wrapCopilotProviderStream as r, wrapCopilotAnthropicStream as t };
