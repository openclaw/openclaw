import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as areRuntimeModelRefsEquivalent } from "./model-runtime-aliases-D35Lx2no.js";
//#region src/status/fallback-notice-state.ts
function resolveActiveFallbackState(params) {
	const selected = normalizeOptionalString(params.state?.fallbackNoticeSelectedModel);
	const active = normalizeOptionalString(params.state?.fallbackNoticeActiveModel);
	const reason = normalizeOptionalString(params.state?.fallbackNoticeReason);
	const fallbackActive = !areRuntimeModelRefsEquivalent(params.selectedModelRef, params.activeModelRef) && selected === params.selectedModelRef && active === params.activeModelRef;
	return {
		active: fallbackActive,
		reason: fallbackActive ? reason : void 0
	};
}
//#endregion
export { resolveActiveFallbackState as t };
