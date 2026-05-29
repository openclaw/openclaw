//#region src/string.ts
function normalizeOptionalString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
function uniqueTrimmedStrings(values) {
	const seen = /* @__PURE__ */ new Set();
	const result = [];
	for (const value of values) {
		const normalized = normalizeOptionalString(value);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(normalized);
	}
	return result;
}
//#endregion
export { uniqueTrimmedStrings as n, normalizeOptionalString as t };
