import { i as applyXaiModelCompat } from "./model-compat-TbJYnPAX.js";
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
function applyXaiRuntimeModelCompat(model) {
	const withCompat = applyXaiModelCompat(model);
	return {
		...withCompat,
		thinkingLevelMap: {
			...withCompat.thinkingLevelMap,
			...withCompat.reasoning ? XAI_REASONING_EFFORTS : XAI_UNSUPPORTED_REASONING_EFFORTS
		}
	};
}
//#endregion
export { applyXaiRuntimeModelCompat as t };
