import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { c as parseAgentSessionKey, o as normalizeSessionKeyPreservingOpaquePeerIds, r as isCronRunSessionKey, s as normalizeSessionPeerId } from "./session-key-utils-Ce_xWkNq.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
//#region src/routing/session-key.ts
const DEFAULT_AGENT_ID = "main";
const DEFAULT_MAIN_KEY = "main";
const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;
function normalizeToken(value) {
	return normalizeLowercaseStringOrEmpty(value);
}
function scopedHeartbeatWakeOptions(sessionKey, wakeOptions, mainKey, scope) {
	const parsed = parseAgentSessionKey(sessionKey);
	if (!parsed) return wakeOptions;
	if (isCronRunSessionKey(sessionKey)) {
		if (scope === "global") return {
			...wakeOptions,
			agentId: parsed.agentId
		};
		return {
			...wakeOptions,
			sessionKey: buildAgentMainSessionKey({
				agentId: parsed.agentId,
				mainKey
			})
		};
	}
	return {
		...wakeOptions,
		sessionKey
	};
}
function resolveEventSessionKey(sessionKey, mainKey, scope) {
	const parsed = parseAgentSessionKey(sessionKey);
	if (!parsed || !isCronRunSessionKey(sessionKey)) return sessionKey;
	if (scope === "global") return "global";
	return buildAgentMainSessionKey({
		agentId: parsed.agentId,
		mainKey
	});
}
function normalizeMainKey(value) {
	return normalizeLowercaseStringOrEmpty(value) || "main";
}
function toAgentRequestSessionKey(storeKey) {
	const raw = (storeKey ?? "").trim();
	if (!raw) return;
	return parseAgentSessionKey(raw)?.rest ?? raw;
}
function toAgentStoreSessionKey(params) {
	const raw = (params.requestKey ?? "").trim();
	const lowered = normalizeLowercaseStringOrEmpty(raw);
	if (!raw || lowered === "main") return buildAgentMainSessionKey({
		agentId: params.agentId,
		mainKey: params.mainKey
	});
	const parsed = parseAgentSessionKey(raw);
	if (parsed) return `agent:${parsed.agentId}:${parsed.rest}`;
	const normalized = normalizeSessionKeyPreservingOpaquePeerIds(raw);
	if (lowered.startsWith("agent:")) return normalized;
	return `agent:${normalizeAgentId(params.agentId)}:${normalized}`;
}
function resolveAgentIdFromSessionKey(sessionKey) {
	return normalizeAgentId(parseAgentSessionKey(sessionKey)?.agentId ?? "main");
}
function classifySessionKeyShape(sessionKey) {
	const raw = (sessionKey ?? "").trim();
	if (!raw) return "missing";
	if (parseAgentSessionKey(raw)) return "agent";
	return normalizeLowercaseStringOrEmpty(raw).startsWith("agent:") ? "malformed_agent" : "legacy_or_alias";
}
function isUnscopedSessionKeySentinel(sessionKey) {
	const lowered = normalizeLowercaseStringOrEmpty(sessionKey);
	return lowered === "global" || lowered === "unknown";
}
function scopeLegacySessionKeyToAgent(params) {
	const raw = (params.sessionKey ?? "").trim();
	if (!raw) return;
	const agentId = params.agentId?.trim();
	if (!agentId || classifySessionKeyShape(raw) !== "legacy_or_alias") return raw;
	return toAgentStoreSessionKey({
		agentId,
		requestKey: raw,
		mainKey: params.mainKey
	});
}
function normalizeAgentId(value) {
	const trimmed = (value ?? "").trim();
	if (!trimmed) return DEFAULT_AGENT_ID;
	const normalized = normalizeLowercaseStringOrEmpty(trimmed);
	if (VALID_ID_RE.test(trimmed)) return normalized;
	return normalized.replace(INVALID_CHARS_RE, "-").replace(LEADING_DASH_RE, "").replace(TRAILING_DASH_RE, "").slice(0, 64) || "main";
}
function isValidAgentId(value) {
	const trimmed = (value ?? "").trim();
	return Boolean(trimmed) && VALID_ID_RE.test(trimmed);
}
function sanitizeAgentId(value) {
	return normalizeAgentId(value);
}
function buildAgentMainSessionKey(params) {
	return `agent:${normalizeAgentId(params.agentId)}:${normalizeMainKey(params.mainKey)}`;
}
function buildAgentPeerSessionKey(params) {
	const peerKind = params.peerKind ?? "direct";
	if (peerKind === "direct") {
		const dmScope = params.dmScope ?? "main";
		let peerId = (params.peerId ?? "").trim();
		const linkedPeerId = dmScope === "main" ? null : resolveLinkedPeerId({
			identityLinks: params.identityLinks,
			channel: params.channel,
			peerId
		});
		if (linkedPeerId) peerId = linkedPeerId;
		peerId = normalizeLowercaseStringOrEmpty(peerId);
		if (dmScope === "per-account-channel-peer" && peerId) {
			const channel = normalizeLowercaseStringOrEmpty(params.channel) || "unknown";
			const accountId = normalizeAccountId(params.accountId);
			return `agent:${normalizeAgentId(params.agentId)}:${channel}:${accountId}:direct:${peerId}`;
		}
		if (dmScope === "per-channel-peer" && peerId) {
			const channel = normalizeLowercaseStringOrEmpty(params.channel) || "unknown";
			return `agent:${normalizeAgentId(params.agentId)}:${channel}:direct:${peerId}`;
		}
		if (dmScope === "per-peer" && peerId) return `agent:${normalizeAgentId(params.agentId)}:direct:${peerId}`;
		return buildAgentMainSessionKey({
			agentId: params.agentId,
			mainKey: params.mainKey
		});
	}
	const channel = normalizeLowercaseStringOrEmpty(params.channel) || "unknown";
	const peerId = normalizeSessionPeerId({
		channel: params.channel,
		peerKind,
		peerId: params.peerId
	}) || "unknown";
	return `agent:${normalizeAgentId(params.agentId)}:${channel}:${peerKind}:${peerId}`;
}
function resolveLinkedPeerId(params) {
	const identityLinks = params.identityLinks;
	if (!identityLinks) return null;
	const peerId = params.peerId.trim();
	if (!peerId) return null;
	const candidates = /* @__PURE__ */ new Set();
	const rawCandidate = normalizeToken(peerId);
	if (rawCandidate) candidates.add(rawCandidate);
	const channel = normalizeToken(params.channel);
	if (channel) {
		const scopedCandidate = normalizeToken(`${channel}:${peerId}`);
		if (scopedCandidate) candidates.add(scopedCandidate);
	}
	if (candidates.size === 0) return null;
	for (const [canonical, ids] of Object.entries(identityLinks)) {
		const canonicalName = canonical.trim();
		if (!canonicalName) continue;
		if (!Array.isArray(ids)) continue;
		for (const id of ids) {
			const normalized = normalizeToken(id);
			if (normalized && candidates.has(normalized)) return canonicalName;
		}
	}
	return null;
}
function buildGroupHistoryKey(params) {
	const channel = normalizeToken(params.channel) || "unknown";
	const accountId = normalizeAccountId(params.accountId);
	const peerId = normalizeSessionPeerId({
		channel,
		peerKind: params.peerKind,
		peerId: params.peerId
	}) || "unknown";
	return `${channel}:${accountId}:${params.peerKind}:${peerId}`;
}
function resolveThreadSessionKeys(params) {
	const threadId = (params.threadId ?? "").trim();
	if (!threadId) return {
		sessionKey: params.baseSessionKey,
		parentSessionKey: void 0
	};
	const normalizedThread = params.normalizeThreadId?.(threadId) ?? normalizeLowercaseStringOrEmpty(threadId);
	return {
		sessionKey: params.useSuffix ?? true ? `${params.baseSessionKey}:thread:${normalizedThread}` : params.baseSessionKey,
		parentSessionKey: params.parentSessionKey
	};
}
//#endregion
export { toAgentRequestSessionKey as _, buildGroupHistoryKey as a, isValidAgentId as c, resolveAgentIdFromSessionKey as d, resolveEventSessionKey as f, scopedHeartbeatWakeOptions as g, scopeLegacySessionKeyToAgent as h, buildAgentPeerSessionKey as i, normalizeAgentId as l, sanitizeAgentId as m, DEFAULT_MAIN_KEY as n, classifySessionKeyShape as o, resolveThreadSessionKeys as p, buildAgentMainSessionKey as r, isUnscopedSessionKeySentinel as s, DEFAULT_AGENT_ID as t, normalizeMainKey as u, toAgentStoreSessionKey as v };
