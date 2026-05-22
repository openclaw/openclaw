import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
//#region src/status/fallback-notice-state.ts
function resolveActiveFallbackState(params) {
	const selected = normalizeOptionalString(params.state?.fallbackNoticeSelectedModel);
	const active = normalizeOptionalString(params.state?.fallbackNoticeActiveModel);
	const reason = normalizeOptionalString(params.state?.fallbackNoticeReason);
	const fallbackActive = params.selectedModelRef !== params.activeModelRef && selected === params.selectedModelRef && active === params.activeModelRef;
	return {
		active: fallbackActive,
		reason: fallbackActive ? reason : void 0
	};
}
//#endregion
export { resolveActiveFallbackState as t };
