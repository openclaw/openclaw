import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { t as getActivePluginChannelRegistry } from "./runtime-DHxRl5F1.js";
import { i as normalizeConversationText } from "./session-binding-normalization-D9PNZGcW.js";
import { t as resolveConversationBindingContext } from "./conversation-binding-context-DLfjhKKb.js";
//#region src/auto-reply/reply/conversation-binding-input.ts
function resolveBindingChannel(ctx, commandChannel) {
	return normalizeLowercaseStringOrEmpty(normalizeConversationText(ctx.OriginatingChannel ?? commandChannel ?? ctx.Surface ?? ctx.Provider));
}
function resolveBindingAccountId(params) {
	const channel = resolveBindingChannel(params.ctx, params.commandChannel);
	const plugin = getActivePluginChannelRegistry()?.channels.find((entry) => entry.plugin.id === channel)?.plugin;
	return normalizeConversationText(params.ctx.AccountId) || normalizeConversationText(plugin?.config.defaultAccountId?.(params.cfg)) || "default";
}
function resolveBindingThreadId(threadId) {
	return (threadId != null ? normalizeConversationText(String(threadId)) : void 0) || void 0;
}
function resolveConversationBindingContextFromMessage(params) {
	const channel = resolveBindingChannel(params.ctx);
	return resolveConversationBindingContext({
		cfg: params.cfg,
		channel,
		accountId: resolveBindingAccountId({
			ctx: params.ctx,
			cfg: params.cfg,
			commandChannel: channel
		}),
		chatType: params.ctx.ChatType,
		threadId: resolveBindingThreadId(params.ctx.MessageThreadId),
		threadParentId: params.ctx.ThreadParentId,
		senderId: params.senderId ?? params.ctx.SenderId,
		sessionKey: params.sessionKey ?? params.ctx.SessionKey,
		parentSessionKey: params.parentSessionKey ?? params.ctx.ParentSessionKey,
		from: params.ctx.From,
		originatingTo: params.ctx.OriginatingTo,
		commandTo: params.commandTo,
		fallbackTo: params.ctx.To,
		nativeChannelId: params.ctx.NativeChannelId
	});
}
function resolveConversationBindingContextFromAcpCommand(params) {
	return resolveConversationBindingContextFromMessage({
		cfg: params.cfg,
		ctx: params.ctx,
		senderId: params.command.senderId,
		sessionKey: params.sessionKey,
		parentSessionKey: params.ctx.ParentSessionKey,
		commandTo: params.command.to
	});
}
function resolveConversationBindingChannelFromMessage(ctx, commandChannel) {
	return resolveBindingChannel(ctx, commandChannel);
}
function resolveConversationBindingAccountIdFromMessage(params) {
	return resolveBindingAccountId(params);
}
function resolveConversationBindingThreadIdFromMessage(ctx) {
	return resolveBindingThreadId(ctx.MessageThreadId);
}
//#endregion
export { resolveConversationBindingThreadIdFromMessage as a, resolveConversationBindingContextFromMessage as i, resolveConversationBindingChannelFromMessage as n, resolveConversationBindingContextFromAcpCommand as r, resolveConversationBindingAccountIdFromMessage as t };
