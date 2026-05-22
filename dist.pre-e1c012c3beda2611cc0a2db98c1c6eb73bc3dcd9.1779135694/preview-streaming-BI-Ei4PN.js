import { m as resolveChannelPreviewStreamMode } from "./channel-streaming-ktRXTXrf.js";
//#region extensions/telegram/src/preview-streaming.ts
function resolveTelegramPreviewStreamMode(params = {}) {
	return resolveChannelPreviewStreamMode(params, "partial");
}
//#endregion
export { resolveTelegramPreviewStreamMode as t };
