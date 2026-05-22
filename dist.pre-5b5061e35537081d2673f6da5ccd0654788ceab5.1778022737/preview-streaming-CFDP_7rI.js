//#region extensions/discord/src/preview-streaming.ts
function parsePreviewStreamingMode(value) {
	return value === "off" || value === "partial" || value === "block" ? value : void 0;
}
function resolveDiscordPreviewStreamMode(params = {}) {
	const parsedStreaming = params.streaming && typeof params.streaming === "object" && !Array.isArray(params.streaming) ? parsePreviewStreamingMode(params.streaming.mode ?? params.streaming.streaming) : parsePreviewStreamingMode(params.streaming);
	if (parsedStreaming) return parsedStreaming;
	const legacy = parsePreviewStreamingMode(params.streamMode);
	if (legacy) return legacy;
	if (typeof params.streaming === "boolean") return params.streaming ? "partial" : "off";
	return "off";
}
//#endregion
export { resolveDiscordPreviewStreamMode as t };
