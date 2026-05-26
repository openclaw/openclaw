import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { t as buildChannelOutboundSessionRoute } from "./core-kXuNbs5U.js";
//#region extensions/zalouser/src/session-route.ts
function stripZalouserTargetPrefix(raw) {
	return raw.trim().replace(/^(zalouser|zlu):/i, "").trim();
}
function normalizeZalouserTarget(raw) {
	const trimmed = stripZalouserTargetPrefix(raw);
	if (!trimmed) return;
	const lower = normalizeLowercaseStringOrEmpty(trimmed);
	if (lower.startsWith("group:")) {
		const id = trimmed.slice(6).trim();
		return id ? `group:${id}` : void 0;
	}
	if (lower.startsWith("g:")) {
		const id = trimmed.slice(2).trim();
		return id ? `group:${id}` : void 0;
	}
	if (lower.startsWith("user:")) {
		const id = trimmed.slice(5).trim();
		return id ? `user:${id}` : void 0;
	}
	if (lower.startsWith("dm:")) {
		const id = trimmed.slice(3).trim();
		return id ? `user:${id}` : void 0;
	}
	if (lower.startsWith("u:")) {
		const id = trimmed.slice(2).trim();
		return id ? `user:${id}` : void 0;
	}
	if (/^g-\S+$/i.test(trimmed)) return `group:${trimmed}`;
	if (/^u-\S+$/i.test(trimmed)) return `user:${trimmed}`;
	return trimmed;
}
function parseZalouserOutboundTarget(raw) {
	const normalized = normalizeZalouserTarget(raw);
	if (!normalized) throw new Error("Zalouser target is required");
	const lowered = normalizeLowercaseStringOrEmpty(normalized);
	if (lowered.startsWith("group:")) {
		const threadId = normalized.slice(6).trim();
		if (!threadId) throw new Error("Zalouser group target is missing group id");
		return {
			threadId,
			isGroup: true
		};
	}
	if (lowered.startsWith("user:")) {
		const threadId = normalized.slice(5).trim();
		if (!threadId) throw new Error("Zalouser user target is missing user id");
		return {
			threadId,
			isGroup: false
		};
	}
	return {
		threadId: normalized,
		isGroup: false
	};
}
function parseZalouserDirectoryGroupId(raw) {
	const normalized = normalizeZalouserTarget(raw);
	if (!normalized) throw new Error("Zalouser group target is required");
	const lowered = normalizeLowercaseStringOrEmpty(normalized);
	if (lowered.startsWith("group:")) {
		const groupId = normalized.slice(6).trim();
		if (!groupId) throw new Error("Zalouser group target is missing group id");
		return groupId;
	}
	if (lowered.startsWith("user:")) throw new Error("Zalouser group members lookup requires a group target (group:<id>)");
	return normalized;
}
function resolveZalouserOutboundSessionRoute(params) {
	const normalized = normalizeZalouserTarget(params.target);
	if (!normalized) return null;
	const isGroup = (normalizeOptionalLowercaseString(normalized) ?? "").startsWith("group:");
	const peerId = normalized.replace(/^(group|user):/i, "").trim();
	return buildChannelOutboundSessionRoute({
		cfg: params.cfg,
		agentId: params.agentId,
		channel: "zalouser",
		accountId: params.accountId,
		peer: {
			kind: isGroup ? "group" : "direct",
			id: peerId
		},
		chatType: isGroup ? "group" : "direct",
		from: isGroup ? `zalouser:group:${peerId}` : `zalouser:${peerId}`,
		to: `zalouser:${peerId}`
	});
}
//#endregion
export { resolveZalouserOutboundSessionRoute as i, parseZalouserDirectoryGroupId as n, parseZalouserOutboundTarget as r, normalizeZalouserTarget as t };
