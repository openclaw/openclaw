import { i as applyXaiModelCompat } from "./model-compat-BZh9v7o3.js";
//#region extensions/xai/runtime-model-compat.ts
const XAI_UNSUPPORTED_REASONING_EFFORTS = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: null,
	xhigh: null
};
const XAI_REASONING_EFFORTS = {
	off: null,
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "high"
};
const XAI_SUPPORTED_REASONING_EFFORTS = [
	"low",
	"medium",
	"high"
];
function normalizeXaiCompatModelId(id) {
	return typeof id === "string" ? id.trim().toLowerCase() : "";
}
function supportsConfigurableXaiReasoningEffort(model) {
	const id = normalizeXaiCompatModelId(model.id);
	return model.reasoning === true && (id === "grok-4.3" || id.startsWith("grok-4.3-"));
}
function resolveXaiReasoningEffortCompat(model) {
	if (supportsConfigurableXaiReasoningEffort(model)) return {
		supportsReasoningEffort: true,
		supportedReasoningEfforts: [...XAI_SUPPORTED_REASONING_EFFORTS]
	};
	return { supportsReasoningEffort: false };
}
function applyXaiRuntimeModelCompat(model) {
	const withCompat = applyXaiModelCompat(model);
	const supportsReasoningEffort = supportsConfigurableXaiReasoningEffort(withCompat);
	const existingCompat = withCompat.compat && typeof withCompat.compat === "object" ? withCompat.compat : {};
	return {
		...withCompat,
		compat: {
			...existingCompat,
			...resolveXaiReasoningEffortCompat(withCompat)
		},
		thinkingLevelMap: {
			...withCompat.thinkingLevelMap,
			...supportsReasoningEffort ? XAI_REASONING_EFFORTS : XAI_UNSUPPORTED_REASONING_EFFORTS
		}
	};
}
//#endregion
export { applyXaiRuntimeModelCompat as t };
