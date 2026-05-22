import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { u as normalizeMessageChannel } from "./message-channel-HzKd5Jx-.js";
import "./delivery-context.shared-DttZ-aqI.js";
import { a as normalizeChannelId, t as getChannelPlugin } from "./registry-CkSYsHAS2.js";
import "./plugins-J90h611X.js";
//#region src/utils/delivery-context.ts
function normalizeConversationId(value) {
	return typeof value === "number" && Number.isFinite(value) ? String(Math.trunc(value)) : typeof value === "string" ? normalizeOptionalString(value) : void 0;
}
function normalizeConversationTargetParams(params) {
	return {
		channel: typeof params.channel === "string" ? normalizeMessageChannel(params.channel) ?? params.channel.trim() : void 0,
		conversationId: normalizeConversationId(params.conversationId),
		parentConversationId: normalizeConversationId(params.parentConversationId)
	};
}
function formatConversationTarget(params) {
	const { channel, conversationId, parentConversationId } = normalizeConversationTargetParams(params);
	if (!channel || !conversationId) return;
	const pluginTarget = normalizeChannelId(channel) ? getChannelPlugin(normalizeChannelId(channel))?.messaging?.resolveDeliveryTarget?.({
		conversationId,
		parentConversationId
	}) : null;
	if (pluginTarget?.to?.trim()) return pluginTarget.to.trim();
	return `channel:${conversationId}`;
}
function resolveConversationDeliveryTarget(params) {
	const { channel, conversationId, parentConversationId } = normalizeConversationTargetParams(params);
	const pluginTarget = channel && conversationId ? getChannelPlugin(normalizeChannelId(channel) ?? channel)?.messaging?.resolveDeliveryTarget?.({
		conversationId,
		parentConversationId
	}) : null;
	if (pluginTarget) return {
		...pluginTarget.to?.trim() ? { to: pluginTarget.to.trim() } : {},
		...pluginTarget.threadId?.trim() ? { threadId: pluginTarget.threadId.trim() } : {}
	};
	return { to: formatConversationTarget(params) };
}
//#endregion
export { resolveConversationDeliveryTarget as n, formatConversationTarget as t };
