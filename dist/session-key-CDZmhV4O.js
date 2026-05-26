import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { l as normalizeE164 } from "./utils-CKsuXgDI.js";
import { c as normalizeAgentId, l as normalizeMainKey, r as buildAgentMainSessionKey, t as DEFAULT_AGENT_ID } from "./session-key-DFEyR49L.js";
import { u as normalizeMessageChannel } from "./message-channel-s-A-ruKR.js";
import { i as listChannelPlugins, n as getLoadedChannelPlugin } from "./registry-BdfZSqhE2.js";
import { g as resolveGroupSessionKey } from "./store-3qAZ3Zl6.js";
import "./plugins-YTdL-Pji.js";
//#region src/config/sessions/explicit-session-key-normalization.ts
function resolveExplicitSessionKeyNormalizerCandidates(sessionKey, ctx) {
	const normalizedProvider = normalizeOptionalLowercaseString(ctx.Provider);
	const normalizedSurface = normalizeOptionalLowercaseString(ctx.Surface);
	const normalizedFrom = normalizeLowercaseStringOrEmpty(ctx.From);
	const candidates = /* @__PURE__ */ new Set();
	const maybeAdd = (value) => {
		const normalized = normalizeMessageChannel(value);
		if (normalized) candidates.add(normalized);
	};
	maybeAdd(normalizedSurface);
	maybeAdd(normalizedProvider);
	maybeAdd(normalizedFrom.split(":", 1)[0]);
	for (const plugin of listChannelPlugins()) {
		const pluginId = normalizeMessageChannel(plugin.id);
		if (!pluginId) continue;
		if (sessionKey.startsWith(`${pluginId}:`) || sessionKey.includes(`:${pluginId}:`)) candidates.add(pluginId);
	}
	return [...candidates];
}
function normalizeExplicitSessionKey(sessionKey, ctx) {
	const normalized = normalizeLowercaseStringOrEmpty(sessionKey);
	for (const channelId of resolveExplicitSessionKeyNormalizerCandidates(normalized, ctx)) {
		const normalize = getLoadedChannelPlugin(channelId)?.messaging?.normalizeExplicitSessionKey;
		const next = normalize?.({
			sessionKey: normalized,
			ctx
		});
		if (typeof next === "string" && next.trim()) return normalizeLowercaseStringOrEmpty(next);
	}
	return normalized;
}
//#endregion
//#region src/config/sessions/session-key.ts
function deriveSessionKey(scope, ctx) {
	if (scope === "global") return "global";
	const resolvedGroup = resolveGroupSessionKey(ctx);
	if (resolvedGroup) return resolvedGroup.key;
	return (ctx.From ? normalizeE164(ctx.From) : "") || "unknown";
}
/**
* Resolve the session key with a canonical direct-chat bucket (default: "main").
* All non-group direct chats collapse to this bucket; groups stay isolated.
*/
function resolveSessionKey(scope, ctx, mainKey, agentId = DEFAULT_AGENT_ID) {
	const explicit = ctx.SessionKey?.trim();
	if (explicit) return normalizeExplicitSessionKey(explicit, ctx);
	const raw = deriveSessionKey(scope, ctx);
	if (scope === "global") return raw;
	const canonicalAgentId = normalizeAgentId(agentId);
	const canonical = buildAgentMainSessionKey({
		agentId: canonicalAgentId,
		mainKey: normalizeMainKey(mainKey)
	});
	if (!(raw.includes(":group:") || raw.includes(":channel:"))) return canonical;
	return `agent:${canonicalAgentId}:${raw}`;
}
//#endregion
export { resolveSessionKey as n, deriveSessionKey as t };
