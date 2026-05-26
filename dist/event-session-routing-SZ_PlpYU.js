import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { c as parseAgentSessionKey, u as parseThreadSessionSuffix } from "./session-key-utils-Ce_xWkNq.js";
import { f as resolveEventSessionKey, g as scopedHeartbeatWakeOptions, l as normalizeAgentId, r as buildAgentMainSessionKey } from "./session-key-Bte0mmcq.js";
import { t as deriveSessionChatTypeFromKey } from "./session-chat-type-shared-DwI649ZK.js";
import { i as resolveAgentRoute } from "./resolve-route-C8IahAyG.js";
import { l as resolvePinnedMainDmOwnerFromAllowlist } from "./dm-policy-shared-CXEKnzKD.js";
//#region src/infra/event-session-routing.ts
function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function readAllowFrom(value) {
	if (!isRecord(value)) return;
	const allowFrom = value.allowFrom;
	return Array.isArray(allowFrom) ? allowFrom : void 0;
}
function readDmAllowFrom(value) {
	if (!isRecord(value)) return;
	return readAllowFrom(value.dm);
}
function readAccountConfig(value) {
	return isRecord(value) && isRecord(value.config) ? value.config : void 0;
}
function firstConfiguredAllowFrom(...candidates) {
	return candidates.find((candidate) => candidate !== void 0);
}
function normalizeEntry(value) {
	return normalizeLowercaseStringOrEmpty(value) || void 0;
}
function parseDirectAgentSessionTarget(sessionKey) {
	const { baseSessionKey } = parseThreadSessionSuffix(sessionKey);
	const directSessionKey = baseSessionKey ?? sessionKey;
	const parsed = parseAgentSessionKey(directSessionKey);
	if (!parsed || deriveSessionChatTypeFromKey(directSessionKey) !== "direct") return null;
	const parts = parsed.rest.split(":");
	const directIndex = parts.findIndex((part) => part === "direct" || part === "dm");
	if (directIndex < 0 || directIndex > 2 || directIndex >= parts.length - 1) return null;
	const peerId = normalizeLowercaseStringOrEmpty(parts.slice(directIndex + 1).join(":"));
	if (!peerId) return null;
	return {
		agentId: parsed.agentId,
		...directIndex >= 1 ? { channel: normalizeLowercaseStringOrEmpty(parts[0]) } : {},
		...directIndex >= 2 ? { accountId: normalizeLowercaseStringOrEmpty(parts[1]) } : {},
		peerId
	};
}
function resolveEventSessionAllowFrom(params) {
	const cfg = params.cfg;
	if (!cfg?.channels) return;
	const target = parseDirectAgentSessionTarget(params.sessionKey);
	const channelKey = normalizeLowercaseStringOrEmpty(params.channel ?? target?.channel);
	if (!channelKey) return;
	const channelConfig = isRecord(cfg.channels) ? cfg.channels[channelKey] : void 0;
	if (!isRecord(channelConfig)) return;
	const accountId = normalizeLowercaseStringOrEmpty(params.accountId ?? target?.accountId);
	const accountConfig = accountId && isRecord(channelConfig.accounts) ? channelConfig.accounts[accountId] : void 0;
	const accountNestedConfig = readAccountConfig(accountConfig);
	return firstConfiguredAllowFrom(readDmAllowFrom(accountConfig), readDmAllowFrom(accountNestedConfig), readAllowFrom(accountConfig), readAllowFrom(accountNestedConfig), readDmAllowFrom(channelConfig), readAllowFrom(channelConfig));
}
function shouldPreserveDirectSessionKeyFromRoute(params) {
	if (!params.cfg || !params.target?.channel) return false;
	try {
		const route = resolveAgentRoute({
			cfg: params.cfg,
			channel: params.target.channel,
			accountId: params.target.accountId,
			peer: {
				kind: "direct",
				id: params.target.peerId
			}
		});
		const { baseSessionKey } = parseThreadSessionSuffix(params.sessionKey);
		const normalizedRouteSessionKey = normalizeLowercaseStringOrEmpty(route.sessionKey);
		return route.lastRoutePolicy === "session" && (normalizedRouteSessionKey === normalizeLowercaseStringOrEmpty(params.sessionKey) || baseSessionKey !== void 0 && normalizedRouteSessionKey === normalizeLowercaseStringOrEmpty(baseSessionKey));
	} catch {
		return false;
	}
}
function resolveEventSessionRoutingPolicy(params) {
	const target = parseDirectAgentSessionTarget(params.sessionKey);
	const channel = normalizeLowercaseStringOrEmpty(params.channel ?? target?.channel) || void 0;
	const accountId = normalizeLowercaseStringOrEmpty(params.accountId ?? target?.accountId) || void 0;
	const allowFrom = params.allowFrom ?? resolveEventSessionAllowFrom({
		cfg: params.cfg,
		sessionKey: params.sessionKey,
		channel,
		accountId
	});
	return {
		mainKey: params.cfg?.session?.mainKey,
		sessionScope: params.cfg?.session?.scope,
		dmScope: params.dmScope ?? params.cfg?.session?.dmScope,
		allowFrom,
		channel,
		accountId,
		preserveSessionKey: params.sessionKey ? shouldPreserveDirectSessionKeyFromRoute({
			cfg: params.cfg,
			sessionKey: params.sessionKey,
			target
		}) : false
	};
}
function resolveMainScopedEventSessionKey(params) {
	const sessionKey = params.sessionKey.trim();
	if (!sessionKey || params.policy?.preserveSessionKey === true) return null;
	const parsed = parseAgentSessionKey(sessionKey);
	const target = parseDirectAgentSessionTarget(sessionKey);
	if (!parsed || !target) return null;
	const resolvedAgentId = normalizeAgentId(params.agentId ?? target.agentId);
	if (normalizeAgentId(target.agentId) !== resolvedAgentId) return null;
	const policy = params.policy ?? resolveEventSessionRoutingPolicy({
		cfg: params.cfg,
		sessionKey
	});
	const allowFrom = Array.from(policy.allowFrom ?? []);
	const pinnedOwner = resolvePinnedMainDmOwnerFromAllowlist({
		dmScope: policy.dmScope ?? params.cfg?.session?.dmScope,
		allowFrom,
		normalizeEntry
	});
	if (!pinnedOwner || normalizeEntry(target.peerId) !== pinnedOwner) return null;
	if (shouldPreserveDirectSessionKeyFromRoute({
		cfg: params.cfg,
		sessionKey,
		target
	})) return null;
	if (policy.sessionScope === "global") return "global";
	return buildAgentMainSessionKey({
		agentId: resolvedAgentId,
		mainKey: policy.mainKey ?? params.cfg?.session?.mainKey
	});
}
function resolveEventSessionKeyForPolicy(sessionKey, policy) {
	const cronScoped = resolveEventSessionKey(sessionKey, policy?.mainKey, policy?.sessionScope);
	if (cronScoped !== sessionKey) return cronScoped;
	return resolveMainScopedEventSessionKey({
		sessionKey,
		policy
	}) ?? sessionKey;
}
function scopedHeartbeatWakeOptionsForPolicy(sessionKey, wakeOptions, policy) {
	if (resolveEventSessionKey(sessionKey, policy?.mainKey, policy?.sessionScope) !== sessionKey) return scopedHeartbeatWakeOptions(sessionKey, wakeOptions, policy?.mainKey, policy?.sessionScope);
	const mainScoped = resolveMainScopedEventSessionKey({
		sessionKey,
		policy
	});
	if (mainScoped) {
		if (mainScoped === "global") {
			const agentId = parseAgentSessionKey(sessionKey)?.agentId;
			return agentId ? {
				...wakeOptions,
				agentId
			} : wakeOptions;
		}
		return {
			...wakeOptions,
			sessionKey: mainScoped
		};
	}
	return scopedHeartbeatWakeOptions(sessionKey, wakeOptions, policy?.mainKey, policy?.sessionScope);
}
//#endregion
export { scopedHeartbeatWakeOptionsForPolicy as i, resolveEventSessionRoutingPolicy as n, resolveMainScopedEventSessionKey as r, resolveEventSessionKeyForPolicy as t };
