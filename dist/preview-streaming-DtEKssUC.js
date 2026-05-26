import { d as resolveChannelPreviewStreamMode } from "./channel-streaming-BfXk-s2d.js";
//#region extensions/telegram/src/preview-streaming.ts
function resolveTelegramPreviewStreamMode(params = {}) {
	return resolveChannelPreviewStreamMode(params, "partial");
}
//#endregion
export { resolveTelegramPreviewStreamMode as t };
