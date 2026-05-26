import { m as resolveChannelPreviewStreamMode } from "./channel-streaming-BKIuGSWW.js";
//#region extensions/discord/src/preview-streaming.ts
function resolveDiscordPreviewStreamMode(params = {}) {
	if (params.streaming === void 0 && params.streamMode === void 0) return "progress";
	return resolveChannelPreviewStreamMode(params, "off");
}
//#endregion
export { resolveDiscordPreviewStreamMode as t };
