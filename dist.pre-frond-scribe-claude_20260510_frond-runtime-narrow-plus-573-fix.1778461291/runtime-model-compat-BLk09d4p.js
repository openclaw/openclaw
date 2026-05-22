import { i as applyXaiModelCompat } from "./provider-tools-DgOkcG5J.js";
//#region extensions/xai/runtime-model-compat.ts
const XAI_UNSUPPORTED_REASONING_EFFORTS = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: null,
	xhigh: null
};
function applyXaiRuntimeModelCompat(model) {
	const withCompat = applyXaiModelCompat(model);
	return {
		...withCompat,
		thinkingLevelMap: {
			...withCompat.thinkingLevelMap,
			...XAI_UNSUPPORTED_REASONING_EFFORTS
		}
	};
}
//#endregion
export { applyXaiRuntimeModelCompat as t };
