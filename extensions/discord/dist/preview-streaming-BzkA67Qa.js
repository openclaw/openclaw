import { resolveChannelPreviewStreamMode } from "openclaw/plugin-sdk/channel-streaming";
//#region extensions/discord/src/preview-streaming.ts
function resolveDiscordPreviewStreamMode(params = {}) {
	return resolveChannelPreviewStreamMode(params, "off");
}
//#endregion
export { resolveDiscordPreviewStreamMode as t };
