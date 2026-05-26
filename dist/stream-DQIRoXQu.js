import { r as normalizeProviderId } from "./provider-id-Cz7K6wgK.js";
import "./provider-model-shared-D-slKnZa.js";
import { i as streamWithPayloadPatch } from "./moonshot-thinking-stream-wrappers-DY0RTUKY.js";
import "./provider-stream-shared-BMzmRA_f.js";
import { t as isFireworksKimiModelId } from "./model-id-CpkTUPyb.js";
import { streamSimple } from "@earendil-works/pi-ai";
//#region extensions/fireworks/stream.ts
function isFireworksProviderId(providerId) {
	const normalized = normalizeProviderId(providerId);
	return normalized === "fireworks" || normalized === "fireworks-ai";
}
function createFireworksKimiThinkingDisabledWrapper(baseStreamFn) {
	const underlying = baseStreamFn ?? streamSimple;
	return (model, context, options) => streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
		payloadObj.thinking = { type: "disabled" };
		delete payloadObj.reasoning;
		delete payloadObj.reasoning_effort;
		delete payloadObj.reasoningEffort;
	});
}
function wrapFireworksProviderStream(ctx) {
	if (!isFireworksProviderId(ctx.provider) || ctx.model?.api !== "openai-completions" || !isFireworksKimiModelId(ctx.modelId)) return;
	return createFireworksKimiThinkingDisabledWrapper(ctx.streamFn);
}
//#endregion
export { wrapFireworksProviderStream as n, createFireworksKimiThinkingDisabledWrapper as t };
