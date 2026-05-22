import { o as createPayloadPatchStreamWrapper } from "./provider-stream-shared-jI_a6bxx.js";
//#region extensions/venice/stream.ts
function isVeniceDeepSeekV4ModelId(modelId) {
	return modelId === "deepseek-v4-flash" || modelId === "deepseek-v4-pro";
}
function ensureVeniceDeepSeekV4Replay(payload) {
	delete payload.thinking;
	delete payload.reasoning;
	delete payload.reasoning_effort;
	if (!Array.isArray(payload.messages)) return;
	for (const message of payload.messages) {
		if (!message || typeof message !== "object") continue;
		const record = message;
		if (record.role === "assistant") record.reasoning_content ??= "";
	}
}
function createVeniceDeepSeekV4Wrapper(baseStreamFn, thinkingLevel) {
	return createPayloadPatchStreamWrapper(baseStreamFn, ({ payload, model }) => {
		if (model.provider === "venice" && isVeniceDeepSeekV4ModelId(model.id)) ensureVeniceDeepSeekV4Replay(payload);
	});
}
//#endregion
export { createVeniceDeepSeekV4Wrapper as t };
