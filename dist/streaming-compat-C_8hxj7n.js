import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { b as resolveChannelStreamingNativeTransport, l as getChannelStreamingConfigObject } from "./channel-streaming-BfXk-s2d.js";
import "./string-coerce-runtime-Ce59bOpy.js";
//#region extensions/slack/src/streaming-compat.ts
function normalizeStreamingMode(value) {
	if (typeof value !== "string") return null;
	return (normalizeOptionalString(value) == null ? "" : normalizeLowercaseStringOrEmpty(value)) || null;
}
function parseStreamingMode(value) {
	const normalized = normalizeStreamingMode(value);
	if (normalized === "off" || normalized === "partial" || normalized === "block" || normalized === "progress") return normalized;
	return null;
}
function parseSlackLegacyDraftStreamMode(value) {
	const normalized = normalizeStreamingMode(value);
	if (normalized === "replace" || normalized === "status_final" || normalized === "append") return normalized;
	return null;
}
function mapSlackLegacyDraftStreamModeToStreaming(mode) {
	if (mode === "append") return "block";
	if (mode === "status_final") return "progress";
	return "partial";
}
function mapStreamingModeToSlackLegacyDraftStreamMode(mode) {
	if (mode === "block") return "append";
	if (mode === "progress") return "status_final";
	return "replace";
}
function resolveSlackStreamingMode(params = {}) {
	const parsedStreaming = parseStreamingMode(getChannelStreamingConfigObject(params)?.mode ?? params.streaming);
	if (parsedStreaming) return parsedStreaming;
	const legacyStreamMode = parseSlackLegacyDraftStreamMode(params.streamMode);
	if (legacyStreamMode) return mapSlackLegacyDraftStreamModeToStreaming(legacyStreamMode);
	if (typeof params.streaming === "boolean") return params.streaming ? "partial" : "off";
	return "partial";
}
function resolveSlackNativeStreaming(params = {}) {
	const canonical = resolveChannelStreamingNativeTransport(params);
	if (typeof canonical === "boolean") return canonical;
	if (typeof params.streaming === "boolean") return params.streaming;
	return true;
}
//#endregion
export { resolveSlackNativeStreaming as n, resolveSlackStreamingMode as r, mapStreamingModeToSlackLegacyDraftStreamMode as t };
