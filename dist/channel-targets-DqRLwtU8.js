import { a as normalizeChannelId, t as getChannelPlugin } from "./registry-BdfZSqhE2.js";
//#region src/channels/plugins/tts-capabilities.ts
function resolveChannelTtsVoiceDelivery(channel) {
	const channelId = normalizeChannelId(channel);
	if (!channelId) return;
	return getChannelPlugin(channelId)?.capabilities.tts?.voice;
}
//#endregion
export { resolveChannelTtsVoiceDelivery as t };
