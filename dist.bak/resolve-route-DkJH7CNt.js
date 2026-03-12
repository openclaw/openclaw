import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { Ct as shouldLogVerbose } from "./entry.js";
import { d as resolveDefaultAgentId } from "./agent-scope-C2k6BQnt.js";
import { d as sanitizeAgentId, h as normalizeAccountId, i as buildAgentPeerSessionKey, m as DEFAULT_ACCOUNT_ID, n as DEFAULT_MAIN_KEY, r as buildAgentMainSessionKey, s as normalizeAgentId, t as DEFAULT_AGENT_ID } from "./session-key-qmb11-mH.js";
import { i as logDebug } from "./exec-BhaMholX.js";
import { t as normalizeChatType } from "./chat-type-CEMQNtWX.js";
import { n as listBindings } from "./bindings-DcFNU_QL.js";

//#region src/routing/resolve-route.ts
var resolve_route_exports = /* @__PURE__ */ __exportAll({
	DEFAULT_ACCOUNT_ID: () => DEFAULT_ACCOUNT_ID,
	DEFAULT_AGENT_ID: () => DEFAULT_AGENT_ID,
	buildAgentSessionKey: () => buildAgentSessionKey,
	resolveAgentRoute: () => resolveAgentRoute
});
function normalizeToken(value) {
	return (value ?? "").trim().toLowerCase();
}
function normalizeId(value) {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" || typeof value === "bigint") return String(value).trim();
	return "";
}
function matchesAccountId(match, actual) {
	const trimmed = (match ?? "").trim();
	if (!trimmed) return actual === DEFAULT_ACCOUNT_ID;
	if (trimmed === "*") return true;
	return normalizeAccountId(trimmed) === actual;
}
function buildAgentSessionKey(params) {
	const channel = normalizeToken(params.channel) || "unknown";
	const peer = params.peer;
	return buildAgentPeerSessionKey({
		agentId: params.agentId,
		mainKey: DEFAULT_MAIN_KEY,
		channel,
		accountId: params.accountId,
		peerKind: peer?.kind ?? "direct",
		peerId: peer ? normalizeId(peer.id) || "unknown" : null,
		dmScope: params.dmScope,
		identityLinks: params.identityLinks
	});
}
function listAgents(cfg) {
	const agents = cfg.agents?.list;
	return Array.isArray(agents) ? agents : [];
}
function pickFirstExistingAgentId(cfg, agentId) {
	const trimmed = (agentId ?? "").trim();
	if (!trimmed) return sanitizeAgentId(resolveDefaultAgentId(cfg));
	const normalized = normalizeAgentId(trimmed);
	const agents = listAgents(cfg);
	if (agents.length === 0) return sanitizeAgentId(trimmed);
	const match = agents.find((agent) => normalizeAgentId(agent.id) === normalized);
	if (match?.id?.trim()) return sanitizeAgentId(match.id.trim());
	return sanitizeAgentId(resolveDefaultAgentId(cfg));
}
function matchesChannel(match, channel) {
	const key = normalizeToken(match?.channel);
	if (!key) return false;
	return key === channel;
}
const evaluatedBindingsCacheByCfg = /* @__PURE__ */ new WeakMap();
const MAX_EVALUATED_BINDINGS_CACHE_KEYS = 2e3;
function getEvaluatedBindingsForChannelAccount(cfg, channel, accountId) {
	const bindingsRef = cfg.bindings;
	const existing = evaluatedBindingsCacheByCfg.get(cfg);
	const cache = existing && existing.bindingsRef === bindingsRef ? existing : {
		bindingsRef,
		byChannelAccount: /* @__PURE__ */ new Map()
	};
	if (cache !== existing) evaluatedBindingsCacheByCfg.set(cfg, cache);
	const cacheKey = `${channel}\t${accountId}`;
	const hit = cache.byChannelAccount.get(cacheKey);
	if (hit) return hit;
	const evaluated = listBindings(cfg).flatMap((binding) => {
		if (!binding || typeof binding !== "object") return [];
		if (!matchesChannel(binding.match, channel)) return [];
		if (!matchesAccountId(binding.match?.accountId, accountId)) return [];
		return [{
			binding,
			match: normalizeBindingMatch(binding.match)
		}];
	});
	cache.byChannelAccount.set(cacheKey, evaluated);
	if (cache.byChannelAccount.size > MAX_EVALUATED_BINDINGS_CACHE_KEYS) {
		cache.byChannelAccount.clear();
		cache.byChannelAccount.set(cacheKey, evaluated);
	}
	return evaluated;
}
function normalizePeerConstraint(peer) {
	if (!peer) return { state: "none" };
	const kind = normalizeChatType(peer.kind);
	const id = normalizeId(peer.id);
	if (!kind || !id) return { state: "invalid" };
	return {
		state: "valid",
		kind,
		id
	};
}
function normalizeBindingMatch(match) {
	const rawRoles = match?.roles;
	return {
		accountPattern: (match?.accountId ?? "").trim(),
		peer: normalizePeerConstraint(match?.peer),
		guildId: normalizeId(match?.guildId) || null,
		teamId: normalizeId(match?.teamId) || null,
		roles: Array.isArray(rawRoles) && rawRoles.length > 0 ? rawRoles : null
	};
}
function hasGuildConstraint(match) {
	return Boolean(match.guildId);
}
function hasTeamConstraint(match) {
	return Boolean(match.teamId);
}
function hasRolesConstraint(match) {
	return Boolean(match.roles);
}
function matchesBindingScope(match, scope) {
	if (match.peer.state === "invalid") return false;
	if (match.peer.state === "valid") {
		if (!scope.peer || scope.peer.kind !== match.peer.kind || scope.peer.id !== match.peer.id) return false;
	}
	if (match.guildId && match.guildId !== scope.guildId) return false;
	if (match.teamId && match.teamId !== scope.teamId) return false;
	if (match.roles) {
		for (const role of match.roles) if (scope.memberRoleIds.has(role)) return true;
		return false;
	}
	return true;
}
function resolveAgentRoute(input) {
	const channel = normalizeToken(input.channel);
	const accountId = normalizeAccountId(input.accountId);
	const peer = input.peer ? {
		kind: normalizeChatType(input.peer.kind) ?? input.peer.kind,
		id: normalizeId(input.peer.id)
	} : null;
	const guildId = normalizeId(input.guildId);
	const teamId = normalizeId(input.teamId);
	const memberRoleIds = input.memberRoleIds ?? [];
	const memberRoleIdSet = new Set(memberRoleIds);
	const bindings = getEvaluatedBindingsForChannelAccount(input.cfg, channel, accountId);
	const dmScope = input.cfg.session?.dmScope ?? "main";
	const identityLinks = input.cfg.session?.identityLinks;
	const choose = (agentId, matchedBy) => {
		const resolvedAgentId = pickFirstExistingAgentId(input.cfg, agentId);
		return {
			agentId: resolvedAgentId,
			channel,
			accountId,
			sessionKey: buildAgentSessionKey({
				agentId: resolvedAgentId,
				channel,
				accountId,
				peer,
				dmScope,
				identityLinks
			}).toLowerCase(),
			mainSessionKey: buildAgentMainSessionKey({
				agentId: resolvedAgentId,
				mainKey: DEFAULT_MAIN_KEY
			}).toLowerCase(),
			matchedBy
		};
	};
	const shouldLogDebug = shouldLogVerbose();
	const formatPeer = (value) => value?.kind && value?.id ? `${value.kind}:${value.id}` : "none";
	const formatNormalizedPeer = (value) => {
		if (value.state === "none") return "none";
		if (value.state === "invalid") return "invalid";
		return `${value.kind}:${value.id}`;
	};
	if (shouldLogDebug) {
		logDebug(`[routing] resolveAgentRoute: channel=${channel} accountId=${accountId} peer=${formatPeer(peer)} guildId=${guildId || "none"} teamId=${teamId || "none"} bindings=${bindings.length}`);
		for (const entry of bindings) logDebug(`[routing] binding: agentId=${entry.binding.agentId} accountPattern=${entry.match.accountPattern || "default"} peer=${formatNormalizedPeer(entry.match.peer)} guildId=${entry.match.guildId ?? "none"} teamId=${entry.match.teamId ?? "none"} roles=${entry.match.roles?.length ?? 0}`);
	}
	const parentPeer = input.parentPeer ? {
		kind: normalizeChatType(input.parentPeer.kind) ?? input.parentPeer.kind,
		id: normalizeId(input.parentPeer.id)
	} : null;
	const baseScope = {
		guildId,
		teamId,
		memberRoleIds: memberRoleIdSet
	};
	const tiers = [
		{
			matchedBy: "binding.peer",
			enabled: Boolean(peer),
			scopePeer: peer,
			predicate: (candidate) => candidate.match.peer.state === "valid"
		},
		{
			matchedBy: "binding.peer.parent",
			enabled: Boolean(parentPeer && parentPeer.id),
			scopePeer: parentPeer && parentPeer.id ? parentPeer : null,
			predicate: (candidate) => candidate.match.peer.state === "valid"
		},
		{
			matchedBy: "binding.guild+roles",
			enabled: Boolean(guildId && memberRoleIds.length > 0),
			scopePeer: peer,
			predicate: (candidate) => hasGuildConstraint(candidate.match) && hasRolesConstraint(candidate.match)
		},
		{
			matchedBy: "binding.guild",
			enabled: Boolean(guildId),
			scopePeer: peer,
			predicate: (candidate) => hasGuildConstraint(candidate.match) && !hasRolesConstraint(candidate.match)
		},
		{
			matchedBy: "binding.team",
			enabled: Boolean(teamId),
			scopePeer: peer,
			predicate: (candidate) => hasTeamConstraint(candidate.match)
		},
		{
			matchedBy: "binding.account",
			enabled: true,
			scopePeer: peer,
			predicate: (candidate) => candidate.match.accountPattern !== "*"
		},
		{
			matchedBy: "binding.channel",
			enabled: true,
			scopePeer: peer,
			predicate: (candidate) => candidate.match.accountPattern === "*"
		}
	];
	for (const tier of tiers) {
		if (!tier.enabled) continue;
		const matched = bindings.find((candidate) => tier.predicate(candidate) && matchesBindingScope(candidate.match, {
			...baseScope,
			peer: tier.scopePeer
		}));
		if (matched) {
			if (shouldLogDebug) logDebug(`[routing] match: matchedBy=${tier.matchedBy} agentId=${matched.binding.agentId}`);
			return choose(matched.binding.agentId, tier.matchedBy);
		}
	}
	return choose(resolveDefaultAgentId(input.cfg), "default");
}

//#endregion
export { resolveAgentRoute as n, resolve_route_exports as r, buildAgentSessionKey as t };