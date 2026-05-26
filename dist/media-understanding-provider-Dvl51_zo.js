import { i as describeImagesWithModelPayloadTransform, n as describeImageWithModelPayloadTransform } from "./image-runtime-pndfllVY.js";
import "./media-understanding-CR4579N1.js";
//#region extensions/opencode/media-understanding-provider.ts
function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function stripOpencodeDisabledResponsesReasoningPayload(payload) {
	if (!isRecord(payload)) return;
	const reasoning = payload.reasoning;
	if (reasoning === "none") {
		delete payload.reasoning;
		return;
	}
	if (!isRecord(reasoning) || reasoning.effort !== "none") return;
	delete payload.reasoning;
}
const stripDisabledResponsesReasoning = (payload) => {
	stripOpencodeDisabledResponsesReasoningPayload(payload);
};
const opencodeMediaUnderstandingProvider = {
	id: "opencode",
	capabilities: ["image"],
	defaultModels: { image: "gpt-5-nano" },
	describeImage: (request) => describeImageWithModelPayloadTransform(request, stripDisabledResponsesReasoning),
	describeImages: (request) => describeImagesWithModelPayloadTransform(request, stripDisabledResponsesReasoning)
};
//#endregion
export { stripOpencodeDisabledResponsesReasoningPayload as n, opencodeMediaUnderstandingProvider as t };
