import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
//#region src/shared/model-param-b.ts
function inferParamBFromIdOrName(text) {
	const matches = normalizeLowercaseStringOrEmpty(text).matchAll(/(?:^|[^a-z0-9])[a-z]?(\d+(?:\.\d+)?)b(?:[^a-z0-9]|$)/g);
	let best = null;
	for (const match of matches) {
		const numRaw = match[1];
		if (!numRaw) continue;
		const value = Number(numRaw);
		if (!Number.isFinite(value) || value <= 0) continue;
		if (best === null || value > best) best = value;
	}
	return best;
}
//#endregion
export { inferParamBFromIdOrName as t };
