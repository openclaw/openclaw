import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
//#region src/gateway/device-metadata-normalization.ts
function normalizeTrimmedMetadata(value) {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	return trimmed ? trimmed : "";
}
function toLowerAscii(input) {
	return input.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}
function normalizeDeviceMetadataForAuth(value) {
	const trimmed = normalizeTrimmedMetadata(value);
	if (!trimmed) return "";
	return toLowerAscii(trimmed);
}
function normalizeDeviceMetadataForPolicy(value) {
	const trimmed = normalizeTrimmedMetadata(value);
	if (!trimmed) return "";
	return normalizeLowercaseStringOrEmpty(trimmed.normalize("NFKD").replace(/\p{M}/gu, ""));
}
//#endregion
export { normalizeDeviceMetadataForPolicy as n, normalizeDeviceMetadataForAuth as t };
