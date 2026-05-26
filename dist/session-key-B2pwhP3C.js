import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { l as normalizeE164 } from "./utils-sBTEdeml.js";
import { o as normalizeSessionKeyPreservingOpaquePeerIds } from "./session-key-utils-Ce_xWkNq.js";
import { l as normalizeAgentId, r as buildAgentMainSessionKey, t as DEFAULT_AGENT_ID, u as normalizeMainKey } from "./session-key-Bte0mmcq.js";
import { u as normalizeMessageChannel } from "./message-channel-CYCKkVrh.js";
import { i as listChannelPlugins, n as getLoadedChannelPlugin } from "./registry-Bf5TpUad.js";
import { b as resolveGroupSessionKey } from "./store-BmtchQvp.js";
import "./plugins-DYTHbmt7.js";
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
	const normalized = normalizeSessionKeyPreservingOpaquePeerIds(sessionKey);
	for (const channelId of resolveExplicitSessionKeyNormalizerCandidates(normalized, ctx)) {
		const normalize = getLoadedChannelPlugin(channelId)?.messaging?.normalizeExplicitSessionKey;
		const next = normalize?.({
			sessionKey: normalized,
			ctx
		});
		if (typeof next === "string" && next.trim()) return normalizeSessionKeyPreservingOpaquePeerIds(next);
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
