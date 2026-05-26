import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { c as parseAgentSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { t as getBootstrapChannelPlugin } from "./bootstrap-registry-W87CNNcz.js";
import { t as normalizeChatType } from "./chat-type-D_QPUzR1.js";
import { t as deriveSessionChatTypeFromKey } from "./session-chat-type-shared-DwI649ZK.js";
import { n as resolveSourceReplyDeliveryMode } from "./source-reply-delivery-mode-Dng9YkQe.js";
//#region src/sessions/session-chat-type.ts
function resolveScopedSessionKey(sessionKey) {
	const raw = normalizeLowercaseStringOrEmpty(sessionKey);
	if (!raw) return "";
	return parseAgentSessionKey(raw)?.rest ?? raw;
}
function collectLegacyChatTypeCandidatePluginIds(scopedSessionKey) {
	const ids = /* @__PURE__ */ new Set();
	const firstToken = scopedSessionKey.split(":").find(Boolean);
	if (firstToken) ids.add(firstToken);
	if (scopedSessionKey.includes("@g.us")) ids.add("whatsapp");
	return Array.from(ids);
}
function derivePluginLegacySessionChatType(scopedSessionKey, deriveLegacySessionChatType) {
	if (!deriveLegacySessionChatType) return;
	return deriveLegacySessionChatType(scopedSessionKey);
}
function deriveSessionChatType(sessionKey) {
	const builtInType = deriveSessionChatTypeFromKey(sessionKey);
	if (builtInType !== "unknown") return builtInType;
	const scopedSessionKey = resolveScopedSessionKey(sessionKey);
	for (const pluginId of collectLegacyChatTypeCandidatePluginIds(scopedSessionKey)) {
		const derived = derivePluginLegacySessionChatType(scopedSessionKey, getBootstrapChannelPlugin(pluginId)?.messaging?.deriveLegacySessionChatType);
		if (derived) return derived;
	}
	return "unknown";
}
//#endregion
//#region src/auto-reply/reply/completion-delivery-policy.ts
function resolveCompletionChatType(params) {
	const explicit = normalizeChatType(params.requesterEntry?.chatType ?? params.requesterEntry?.origin?.chatType ?? void 0);
	if (explicit) return explicit;
	for (const key of [params.targetRequesterSessionKey, params.requesterSessionKey]) {
		const derived = deriveSessionChatType(key);
		if (derived !== "unknown") return derived;
	}
	return inferCompletionChatTypeFromTarget(params.directOrigin?.to ?? params.requesterSessionOrigin?.to);
}
function completionRequiresMessageToolDelivery(params) {
	return resolveSourceReplyDeliveryMode({
		cfg: params.cfg,
		ctx: { ChatType: resolveCompletionChatType(params) },
		messageToolAvailable: params.messageToolAvailable
	}) === "message_tool_only";
}
function shouldRouteCompletionThroughRequesterSession(sessionKey) {
	const chatType = deriveSessionChatType(sessionKey);
	return chatType === "group" || chatType === "channel";
}
function inferCompletionChatTypeFromTarget(to) {
	const normalized = to?.trim().toLowerCase();
	if (!normalized) return "unknown";
	if (normalized.startsWith("group:")) return "group";
	if (normalized.startsWith("channel:") || normalized.startsWith("thread:")) return "channel";
	if (normalized.startsWith("dm:") || normalized.startsWith("direct:") || normalized.startsWith("user:")) return "direct";
	return "unknown";
}
//#endregion
export { deriveSessionChatType as i, resolveCompletionChatType as n, shouldRouteCompletionThroughRequesterSession as r, completionRequiresMessageToolDelivery as t };
