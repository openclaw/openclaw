import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { s as parseRawSessionConversationRef } from "./session-key-utils-8PXPWO4Z.js";
//#region src/plugins/hook-agent-context.ts
const TARGET_PREFIXES = new Set([
	"channel",
	"chat",
	"direct",
	"dm",
	"group",
	"thread",
	"user"
]);
function normalizeKey(value) {
	return (value ?? "").trim().toLowerCase();
}
function stripConversationPrefix(value, provider) {
	const text = normalizeOptionalString(value);
	if (!text) return;
	const separatorIndex = text.indexOf(":");
	if (separatorIndex === -1) return text;
	const prefix = normalizeKey(text.slice(0, separatorIndex));
	const suffix = normalizeOptionalString(text.slice(separatorIndex + 1));
	if (!suffix) return text;
	if (TARGET_PREFIXES.has(prefix) || provider && prefix === normalizeKey(provider)) return suffix;
	return text;
}
function resolveAgentHookChannelId(params) {
	const provider = normalizeOptionalString(params.messageProvider);
	const parsed = parseRawSessionConversationRef(params.sessionKey);
	if (parsed?.rawId) return parsed.rawId;
	const metadataChannel = stripConversationPrefix(params.currentChannelId ?? void 0, provider) ?? stripConversationPrefix(params.messageTo ?? void 0, provider);
	if (metadataChannel && normalizeKey(metadataChannel) !== normalizeKey(provider)) return metadataChannel;
	const messageChannel = stripConversationPrefix(params.messageChannel ?? void 0, provider);
	if (messageChannel && normalizeKey(messageChannel) !== normalizeKey(provider)) return messageChannel;
	return normalizeOptionalString(params.messageChannel) ?? provider;
}
function buildAgentHookContextChannelFields(params) {
	return {
		messageProvider: normalizeOptionalString(params.messageProvider),
		channelId: resolveAgentHookChannelId(params)
	};
}
//#endregion
export { buildAgentHookContextChannelFields as t };
