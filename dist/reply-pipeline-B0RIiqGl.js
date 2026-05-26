import { t as normalizeAnyChannelId } from "./registry-normalize-DyAO17vM.js";
import { t as getLoadedChannelPluginForRead } from "./registry-loaded-read-B8n0mpjH.js";
import { n as resolveSourceReplyDeliveryMode } from "./source-reply-delivery-mode-Bt1TkIjO.js";
import { n as createReplyPrefixOptions } from "./reply-prefix-DX7GAhsj.js";
import { t as createTypingCallbacks } from "./typing-n06aIKyG.js";
//#region src/channels/message/reply-pipeline.ts
function resolveChannelSourceReplyDeliveryMode(params) {
	return resolveSourceReplyDeliveryMode(params);
}
function createChannelReplyPipeline(params) {
	const channelId = params.channel ? normalizeAnyChannelId(params.channel) ?? params.channel : void 0;
	let plugin;
	let pluginTransformResolved = false;
	const resolvePluginTransform = () => {
		if (pluginTransformResolved) return plugin?.messaging?.transformReplyPayload;
		pluginTransformResolved = true;
		plugin = channelId ? getLoadedChannelPluginForRead(channelId) : void 0;
		return plugin?.messaging?.transformReplyPayload;
	};
	const transformReplyPayload = params.transformReplyPayload ? params.transformReplyPayload : channelId ? (payload) => resolvePluginTransform()?.({
		payload,
		cfg: params.cfg,
		accountId: params.accountId
	}) ?? payload : void 0;
	return {
		...createReplyPrefixOptions({
			cfg: params.cfg,
			agentId: params.agentId,
			channel: params.channel,
			accountId: params.accountId
		}),
		...transformReplyPayload ? { transformReplyPayload } : {},
		...params.typingCallbacks ? { typingCallbacks: params.typingCallbacks } : params.typing ? { typingCallbacks: createTypingCallbacks(params.typing) } : {}
	};
}
//#endregion
export { resolveChannelSourceReplyDeliveryMode as n, createChannelReplyPipeline as t };
