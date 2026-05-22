import { x as isPlainObject } from "./utils-D5swhEXt.js";
import { t as isBlockedObjectKey } from "./prototype-keys-BWjW0VW8.js";
//#region src/config/merge-patch.ts
function isObjectWithStringId(value) {
	if (!isPlainObject(value)) return false;
	return typeof value.id === "string" && value.id.length > 0;
}
/**
* Merge arrays of object-like entries keyed by `id`.
*
* Contract:
* - Base array must be fully id-keyed; otherwise return undefined (caller should replace).
* - Patch entries with valid id merge by id (or append when the id is new).
* - Patch entries without valid id append as-is, avoiding destructive full-array replacement.
*/
function mergeObjectArraysById(base, patch, options) {
	if (!base.every(isObjectWithStringId)) return;
	const merged = [...base];
	const indexById = /* @__PURE__ */ new Map();
	for (const [index, entry] of merged.entries()) {
		if (!isObjectWithStringId(entry)) return;
		indexById.set(entry.id, index);
	}
	for (const patchEntry of patch) {
		if (!isObjectWithStringId(patchEntry)) {
			merged.push(structuredClone(patchEntry));
			continue;
		}
		const existingIndex = indexById.get(patchEntry.id);
		if (existingIndex === void 0) {
			merged.push(structuredClone(patchEntry));
			indexById.set(patchEntry.id, merged.length - 1);
			continue;
		}
		merged[existingIndex] = applyMergePatch(merged[existingIndex], patchEntry, options);
	}
	return merged;
}
function applyMergePatch(base, patch, options = {}) {
	if (!isPlainObject(patch)) return patch;
	const result = isPlainObject(base) ? { ...base } : {};
	for (const [key, value] of Object.entries(patch)) {
		if (isBlockedObjectKey(key)) continue;
		if (value === null) {
			delete result[key];
			continue;
		}
		if (options.mergeObjectArraysById && Array.isArray(result[key]) && Array.isArray(value)) {
			const mergedArray = mergeObjectArraysById(result[key], value, options);
			if (mergedArray) {
				result[key] = mergedArray;
				continue;
			}
		}
		if (isPlainObject(value)) {
			const baseValue = result[key];
			result[key] = applyMergePatch(isPlainObject(baseValue) ? baseValue : {}, value, options);
			continue;
		}
		result[key] = value;
	}
	return result;
}
//#endregion
export { applyMergePatch as t };
