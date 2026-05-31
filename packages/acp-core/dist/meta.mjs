import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
//#region src/meta.ts
function readMetaValue(meta, keys, normalize) {
	if (!meta) return;
	for (const key of keys) {
		const normalized = normalize(meta[key]);
		if (normalized !== void 0) return normalized;
	}
}
function readString(meta, keys) {
	return readMetaValue(meta, keys, normalizeOptionalString);
}
function readBool(meta, keys) {
	return readMetaValue(meta, keys, (value) => typeof value === "boolean" ? value : void 0);
}
function readNumber(meta, keys) {
	return readMetaValue(meta, keys, (value) => typeof value === "number" && Number.isFinite(value) ? value : void 0);
}
function readNonNegativeInteger(meta, keys) {
	return readMetaValue(meta, keys, (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : void 0);
}
//#endregion
export { readBool, readNonNegativeInteger, readNumber, readString };
