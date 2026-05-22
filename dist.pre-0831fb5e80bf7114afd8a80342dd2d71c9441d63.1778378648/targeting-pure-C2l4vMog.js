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
//#endregion
export { normalizeContinuationTargetKey as n, normalizeContinuationTargetKeys as r, CONTINUATION_DELEGATE_FANOUT_MODES as t };
