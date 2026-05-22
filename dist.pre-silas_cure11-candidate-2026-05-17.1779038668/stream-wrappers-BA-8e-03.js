import { t as createSubsystemLogger } from "./subsystem-CwZgZA6E.js";
import { n as createAnthropicThinkingPrefillPayloadWrapper } from "./provider-stream-shared-CXK1L9qr.js";
import "./runtime-env-CIVQRRwe.js";
//#region extensions/cloudflare-ai-gateway/stream-wrappers.ts
const log = createSubsystemLogger("cloudflare-ai-gateway-stream");
function shouldPatchAnthropicMessagesPayload(model) {
	return model?.api === void 0 || model.api === "anthropic-messages";
}
function createCloudflareAiGatewayAnthropicThinkingPrefillWrapper(baseStreamFn) {
	return createAnthropicThinkingPrefillPayloadWrapper(baseStreamFn, (stripped) => {
		log.warn(`removed ${stripped} trailing assistant prefill message${stripped === 1 ? "" : "s"} because Anthropic extended thinking requires conversations to end with a user turn`);
	});
}
function wrapCloudflareAiGatewayProviderStream(ctx) {
	if (!shouldPatchAnthropicMessagesPayload(ctx.model)) return ctx.streamFn;
	return createCloudflareAiGatewayAnthropicThinkingPrefillWrapper(ctx.streamFn);
}
const __testing = {
	log,
	shouldPatchAnthropicMessagesPayload
};
//#endregion
export { createCloudflareAiGatewayAnthropicThinkingPrefillWrapper as n, wrapCloudflareAiGatewayProviderStream as r, __testing as t };
