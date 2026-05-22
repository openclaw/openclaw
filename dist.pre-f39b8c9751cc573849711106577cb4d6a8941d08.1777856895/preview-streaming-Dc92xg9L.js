import { n as resolveChannelPreviewStreamMode } from "./channel-streaming-C02Um11c.js";
//#region extensions/telegram/src/preview-streaming.ts
function resolveTelegramPreviewStreamMode(params = {}) {
	return resolveChannelPreviewStreamMode(params, "partial");
}
//#endregion
export { resolveTelegramPreviewStreamMode as t };
