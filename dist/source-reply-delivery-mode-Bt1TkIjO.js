import { t as normalizeChatType } from "./chat-type-DEba-Ejp.js";
//#region src/auto-reply/reply/source-reply-delivery-mode.ts
function isExplicitSourceReplyCommand(ctx) {
	if (ctx.CommandSource === "native") return true;
	return ctx.CommandSource === "text" && ctx.CommandAuthorized === true;
}
function resolveSourceReplyDeliveryMode(params) {
	if (params.requested) return params.messageToolAvailable === false && params.requested === "message_tool_only" ? "automatic" : params.requested;
	if (isExplicitSourceReplyCommand(params.ctx)) return "automatic";
	const chatType = normalizeChatType(params.ctx.ChatType);
	let mode;
	if (chatType === "group" || chatType === "channel") mode = (params.cfg.messages?.groupChat?.visibleReplies ?? params.cfg.messages?.visibleReplies) === "automatic" ? "automatic" : "message_tool_only";
	else mode = (params.cfg.messages?.visibleReplies ?? params.defaultVisibleReplies) === "message_tool" ? "message_tool_only" : "automatic";
	if (mode === "message_tool_only" && params.messageToolAvailable === false) return "automatic";
	return mode;
}
function resolveSourceReplyVisibilityPolicy(params) {
	const sourceReplyDeliveryMode = resolveSourceReplyDeliveryMode({
		cfg: params.cfg,
		ctx: params.ctx,
		requested: params.requested,
		messageToolAvailable: params.messageToolAvailable,
		defaultVisibleReplies: params.defaultVisibleReplies
	});
	const sendPolicyDenied = params.sendPolicy === "deny";
	const suppressAutomaticSourceDelivery = sourceReplyDeliveryMode === "message_tool_only";
	const suppressDelivery = sendPolicyDenied || suppressAutomaticSourceDelivery;
	const deliverySuppressionReason = sendPolicyDenied ? "sendPolicy: deny" : suppressAutomaticSourceDelivery ? "sourceReplyDeliveryMode: message_tool_only" : "";
	return {
		sourceReplyDeliveryMode,
		sendPolicyDenied,
		suppressAutomaticSourceDelivery,
		suppressDelivery,
		suppressHookUserDelivery: params.suppressAcpChildUserDelivery === true || suppressDelivery,
		suppressHookReplyLifecycle: sendPolicyDenied || params.suppressAcpChildUserDelivery === true || params.explicitSuppressTyping === true || params.shouldSuppressTyping === true,
		suppressTyping: sendPolicyDenied || params.explicitSuppressTyping === true || params.shouldSuppressTyping === true,
		deliverySuppressionReason
	};
}
//#endregion
export { resolveSourceReplyDeliveryMode as n, resolveSourceReplyVisibilityPolicy as r, isExplicitSourceReplyCommand as t };
