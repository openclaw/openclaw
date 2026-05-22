import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
//#region src/auto-reply/continuation/targeting-pure.ts
const CONTINUATION_DELEGATE_FANOUT_MODES = ["tree", "all"];
function normalizeContinuationTargetKey(value) {
	return normalizeOptionalString(value);
}
function normalizeContinuationTargetKeys(values) {
	const seen = /* @__PURE__ */ new Set();
	const keys = [];
	for (const value of values ?? []) {
		const normalized = normalizeContinuationTargetKey(value);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		keys.push(normalized);
	}
	return keys;
}
function hasContinuationDelegateTargeting(targeting) {
	return Boolean(normalizeContinuationTargetKey(targeting.targetSessionKey) || normalizeContinuationTargetKeys(targeting.targetSessionKeys).length > 0 || targeting.fanoutMode);
}
function hasCrossSessionDelegateTargeting(targeting, dispatchingSessionKey) {
	if (targeting.fanoutMode === "all") return true;
	const selfSessionKey = normalizeContinuationTargetKey(dispatchingSessionKey);
	if (!selfSessionKey) return hasContinuationDelegateTargeting(targeting);
	if (normalizeContinuationTargetKeys(targeting.targetSessionKeys).filter((targetSessionKey) => targetSessionKey !== selfSessionKey).length > 0) return true;
	const targetSessionKey = normalizeContinuationTargetKey(targeting.targetSessionKey);
	if (targetSessionKey && targetSessionKey !== selfSessionKey) return true;
	return false;
}
//#endregion
export { normalizeContinuationTargetKeys as a, normalizeContinuationTargetKey as i, hasContinuationDelegateTargeting as n, hasCrossSessionDelegateTargeting as r, CONTINUATION_DELEGATE_FANOUT_MODES as t };
