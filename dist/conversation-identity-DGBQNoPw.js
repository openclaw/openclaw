import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { t as parseDiscordTarget } from "./target-parsing-D1FhMbX6.js";
//#region extensions/discord/src/conversation-identity.ts
function normalizeDiscordTarget(raw, defaultKind) {
	const trimmed = normalizeOptionalString(raw);
	if (!trimmed) return;
	return parseDiscordTarget(trimmed, { defaultKind })?.normalized;
}
function buildDiscordConversationIdentity(kind, rawId) {
	const trimmed = normalizeOptionalString(rawId);
	return trimmed ? `${kind}:${trimmed}` : void 0;
}
function resolveDiscordConversationIdentity(params) {
	return params.isDirectMessage ? buildDiscordConversationIdentity("user", params.userId) : buildDiscordConversationIdentity("channel", params.channelId);
}
function resolveDiscordCurrentConversationIdentity(params) {
	if (normalizeOptionalLowercaseString(params.chatType) === "direct") {
		const senderTarget = normalizeDiscordTarget(params.from, "user");
		if (senderTarget?.startsWith("user:")) return senderTarget;
	}
	for (const candidate of [
		params.originatingTo,
		params.commandTo,
		params.fallbackTo
	]) {
		const target = normalizeDiscordTarget(candidate, "channel");
		if (target) return target;
	}
}
//#endregion
export { resolveDiscordCurrentConversationIdentity as n, resolveDiscordConversationIdentity as t };
