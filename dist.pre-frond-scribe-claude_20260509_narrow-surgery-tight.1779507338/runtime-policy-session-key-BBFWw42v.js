import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { d as resolveAgentIdFromSessionKey, i as buildAgentPeerSessionKey, l as normalizeAgentId, r as buildAgentMainSessionKey, u as normalizeMainKey } from "./session-key-Bte0mmcq.js";
import { t as normalizeChatType } from "./chat-type-D_QPUzR1.js";
//#region src/auto-reply/reply/runtime-policy-session-key.ts
function resolvePolicyChannel(ctx) {
	const raw = normalizeOptionalString(ctx?.OriginatingChannel ?? ctx?.Provider ?? ctx?.Surface);
	if (!raw) return;
	const channel = normalizeLowercaseStringOrEmpty(raw);
	return channel && channel !== "webchat" ? channel : void 0;
}
function resolvePolicyDirectPeerId(ctx) {
	return normalizeOptionalString(ctx?.NativeDirectUserId ?? ctx?.SenderId ?? ctx?.SenderE164 ?? ctx?.SenderUsername ?? ctx?.OriginatingTo ?? ctx?.From ?? ctx?.To);
}
function isMainSessionAlias(params) {
	const raw = normalizeLowercaseStringOrEmpty(params.sessionKey);
	if (!raw) return false;
	const agentId = normalizeAgentId(params.agentId);
	const mainKey = normalizeMainKey(params.cfg?.session?.mainKey);
	const agentMainSessionKey = buildAgentMainSessionKey({
		agentId,
		mainKey
	});
	const agentMainAliasKey = buildAgentMainSessionKey({
		agentId,
		mainKey: "main"
	});
	return raw === "main" || raw === mainKey || raw === agentMainSessionKey || raw === agentMainAliasKey || raw === buildAgentMainSessionKey({
		agentId: "main",
		mainKey
	}) || raw === buildAgentMainSessionKey({
		agentId: "main",
		mainKey: "main"
	}) || params.cfg?.session?.scope === "global" && raw === "global";
}
function resolveRuntimePolicySessionKey(params) {
	const explicitPolicySessionKey = normalizeOptionalString(params.ctx?.RuntimePolicySessionKey);
	if (explicitPolicySessionKey) return explicitPolicySessionKey;
	const sessionKey = normalizeOptionalString(params.sessionKey ?? params.ctx?.CommandTargetSessionKey ?? params.ctx?.SessionKey);
	if (!sessionKey) return;
	const agentId = resolveAgentIdFromSessionKey(sessionKey);
	if (!isMainSessionAlias({
		cfg: params.cfg,
		agentId,
		sessionKey
	})) return sessionKey;
	if (normalizeChatType(params.ctx?.ChatType) !== "direct") return sessionKey;
	const channel = resolvePolicyChannel(params.ctx);
	const peerId = resolvePolicyDirectPeerId(params.ctx);
	if (!channel || !peerId) return sessionKey;
	return buildAgentPeerSessionKey({
		agentId,
		channel,
		accountId: params.ctx?.AccountId,
		peerKind: "direct",
		peerId,
		dmScope: "per-account-channel-peer",
		identityLinks: params.cfg?.session?.identityLinks
	});
}
//#endregion
export { resolveRuntimePolicySessionKey as t };
