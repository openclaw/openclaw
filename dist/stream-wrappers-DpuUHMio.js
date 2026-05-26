import { t as createSubsystemLogger } from "./subsystem-DLRoKDlF.js";
import { n as createAnthropicThinkingPrefillPayloadWrapper } from "./provider-stream-shared-BMzmRA_f.js";
import "./runtime-env-AKjXcC53.js";
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
