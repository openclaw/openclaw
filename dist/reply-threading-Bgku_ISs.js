import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { a as normalizeAnyChannelId } from "./registry-CtWyD2pE.js";
import { t as getChannelPlugin } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { o as isReplyPayloadStatusNotice, r as copyReplyPayloadMetadata } from "./reply-payload-CiT5mlcY.js";
import { n as isSingleUseReplyToMode } from "./reply-reference-OJ849bWH.js";
//#region src/auto-reply/reply/reply-threading.ts
function normalizeReplyToModeChatType(chatType) {
	return chatType === "direct" || chatType === "group" || chatType === "channel" ? chatType : void 0;
}
function resolveConfiguredReplyToMode(cfg, channel, chatType) {
	const provider = normalizeAnyChannelId(channel) ?? normalizeOptionalLowercaseString(channel);
	if (!provider) return "all";
	const channelConfig = cfg.channels?.[provider];
	const normalizedChatType = normalizeReplyToModeChatType(chatType);
	if (normalizedChatType) {
		const scopedMode = channelConfig?.replyToModeByChatType?.[normalizedChatType];
		if (scopedMode !== void 0) return scopedMode;
	}
	if (normalizedChatType === "direct") {
		const legacyDirectMode = channelConfig?.dm?.replyToMode;
		if (legacyDirectMode !== void 0) return legacyDirectMode;
	}
	return channelConfig?.replyToMode ?? "all";
}
function resolveReplyToModeWithThreading(cfg, threading, params = {}) {
	return threading?.resolveReplyToMode?.({
		cfg,
		accountId: params.accountId,
		chatType: params.chatType
	}) ?? resolveConfiguredReplyToMode(cfg, params.channel, params.chatType);
}
function resolveReplyToMode(cfg, channel, accountId, chatType) {
	const normalizedAccountId = normalizeOptionalLowercaseString(accountId);
	if (!normalizedAccountId) return resolveConfiguredReplyToMode(cfg, channel, chatType);
	const provider = normalizeAnyChannelId(channel) ?? normalizeOptionalLowercaseString(channel);
	return resolveReplyToModeWithThreading(cfg, provider ? getChannelPlugin(provider)?.threading : void 0, {
		channel,
		accountId: normalizedAccountId,
		chatType
	});
}
function createReplyToModeFilter(mode, opts = {}) {
	let hasThreaded = false;
	return (payload) => {
		const isStatusNotice = isReplyPayloadStatusNotice(payload);
		if (!payload.replyToId) return payload;
		if (mode === "off") {
			const isExplicit = Boolean(payload.replyToTag) || Boolean(payload.replyToCurrent);
			if (opts.allowExplicitReplyTagsWhenOff && isExplicit && !isStatusNotice) return payload;
			return copyReplyPayloadMetadata(payload, {
				...payload,
				replyToId: void 0
			});
		}
		if (mode === "all") return payload;
		if (isSingleUseReplyToMode(mode) && hasThreaded) {
			if (isStatusNotice) return payload;
			return copyReplyPayloadMetadata(payload, {
				...payload,
				replyToId: void 0
			});
		}
		if (isSingleUseReplyToMode(mode) && !isStatusNotice) hasThreaded = true;
		return payload;
	};
}
function resolveImplicitCurrentMessageReplyAllowance(mode, policy) {
	const implicitCurrentMessage = policy?.implicitCurrentMessage ?? "default";
	if (implicitCurrentMessage === "allow") return true;
	if (implicitCurrentMessage === "deny") return false;
	return mode !== "batched";
}
function resolveBatchedReplyThreadingPolicy(mode, isBatched) {
	if (mode !== "batched") return;
	return { implicitCurrentMessage: isBatched ? "allow" : "deny" };
}
function createReplyToModeFilterForChannel(mode, channel) {
	const normalized = normalizeOptionalLowercaseString(channel);
	return createReplyToModeFilter(mode, { allowExplicitReplyTagsWhenOff: normalized ? true : normalized === "webchat" });
}
//#endregion
export { resolveReplyToMode as i, resolveBatchedReplyThreadingPolicy as n, resolveImplicitCurrentMessageReplyAllowance as r, createReplyToModeFilterForChannel as t };
