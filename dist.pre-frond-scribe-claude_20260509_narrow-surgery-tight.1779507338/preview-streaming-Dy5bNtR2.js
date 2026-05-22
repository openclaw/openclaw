import { m as resolveChannelPreviewStreamMode } from "./channel-streaming-DXthGzTO.js";
//#region extensions/telegram/src/preview-streaming.ts
function resolveTelegramPreviewStreamMode(params = {}) {
	return resolveChannelPreviewStreamMode(params, "partial");
}
//#endregion
export { resolveTelegramPreviewStreamMode as t };
