import { s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { a as normalizeAnyChannelId } from "./registry-CQe4z7Wq.js";
import { t as getChannelPlugin } from "./registry-DDfKx8qu.js";
import "./plugins-CwUH9CaF.js";
import { t as copyReplyPayloadMetadata } from "./reply-payload-C_Q-5cN_.js";
import { n as isSingleUseReplyToMode } from "./reply-reference-DuG4r63x.js";
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
		if (!payload.replyToId) return payload;
		if (mode === "off") {
			const isExplicit = Boolean(payload.replyToTag) || Boolean(payload.replyToCurrent);
			if (opts.allowExplicitReplyTagsWhenOff && isExplicit && !payload.isCompactionNotice) return payload;
			return copyReplyPayloadMetadata(payload, {
				...payload,
				replyToId: void 0
			});
		}
		if (mode === "all") return payload;
		if (isSingleUseReplyToMode(mode) && hasThreaded) {
			if (payload.isCompactionNotice) return payload;
			return copyReplyPayloadMetadata(payload, {
				...payload,
				replyToId: void 0
			});
		}
		if (isSingleUseReplyToMode(mode) && !payload.isCompactionNotice) hasThreaded = true;
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
