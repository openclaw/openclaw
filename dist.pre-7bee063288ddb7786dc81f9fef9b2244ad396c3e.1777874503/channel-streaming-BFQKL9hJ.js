import { s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
//#region src/plugin-sdk/channel-streaming.ts
function asObjectRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function asTextChunkMode(value) {
	return value === "length" || value === "newline" ? value : void 0;
}
function asBoolean(value) {
	return typeof value === "boolean" ? value : void 0;
}
function normalizeStreamingMode(value) {
	if (typeof value !== "string") return null;
	return normalizeOptionalLowercaseString(value) || null;
}
function parsePreviewStreamingMode(value) {
	const normalized = normalizeStreamingMode(value);
	if (normalized === "off" || normalized === "partial" || normalized === "block" || normalized === "progress") return normalized === "progress" ? "partial" : normalized;
	return null;
}
function asBlockStreamingCoalesceConfig(value) {
	return asObjectRecord(value);
}
function asBlockStreamingChunkConfig(value) {
	return asObjectRecord(value);
}
function getChannelStreamingConfigObject(entry) {
	const streaming = asObjectRecord(entry?.streaming);
	return streaming ? streaming : void 0;
}
function resolveChannelStreamingChunkMode(entry) {
	return asTextChunkMode(getChannelStreamingConfigObject(entry)?.chunkMode) ?? asTextChunkMode(entry?.chunkMode);
}
function resolveChannelStreamingBlockEnabled(entry) {
	return asBoolean(getChannelStreamingConfigObject(entry)?.block?.enabled) ?? asBoolean(entry?.blockStreaming);
}
function resolveChannelStreamingBlockCoalesce(entry) {
	return asBlockStreamingCoalesceConfig(getChannelStreamingConfigObject(entry)?.block?.coalesce) ?? asBlockStreamingCoalesceConfig(entry?.blockStreamingCoalesce);
}
function resolveChannelStreamingPreviewChunk(entry) {
	return asBlockStreamingChunkConfig(getChannelStreamingConfigObject(entry)?.preview?.chunk) ?? asBlockStreamingChunkConfig(entry?.draftChunk);
}
function resolveChannelStreamingPreviewToolProgress(entry, defaultValue = true) {
	return asBoolean(getChannelStreamingConfigObject(entry)?.preview?.toolProgress) ?? defaultValue;
}
function resolveChannelStreamingNativeTransport(entry) {
	return asBoolean(getChannelStreamingConfigObject(entry)?.nativeTransport) ?? asBoolean(entry?.nativeStreaming);
}
function resolveChannelPreviewStreamMode(entry, defaultMode) {
	const parsedStreaming = parsePreviewStreamingMode(getChannelStreamingConfigObject(entry)?.mode ?? entry?.streaming);
	if (parsedStreaming) return parsedStreaming;
	const legacy = parsePreviewStreamingMode(entry?.streamMode);
	if (legacy) return legacy;
	if (typeof entry?.streaming === "boolean") return entry.streaming ? "partial" : "off";
	return defaultMode;
}
//#endregion
export { resolveChannelStreamingChunkMode as a, resolveChannelStreamingPreviewToolProgress as c, resolveChannelStreamingBlockEnabled as i, resolveChannelPreviewStreamMode as n, resolveChannelStreamingNativeTransport as o, resolveChannelStreamingBlockCoalesce as r, resolveChannelStreamingPreviewChunk as s, getChannelStreamingConfigObject as t };
