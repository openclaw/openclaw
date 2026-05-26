import { l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { t as normalizeChatType } from "./chat-type-D_QPUzR1.js";
import { a as routeBindingScopeMatches, i as resolveNormalizedRouteBindingMatch, n as normalizeRouteBindingId, r as normalizeRouteBindingRoles, t as normalizeRouteBindingChannelId } from "./binding-scope--iTJcAjb.js";
import { i as listRouteBindings } from "./bindings-D1F1bOgs.js";
import { t as peerKindMatches } from "./peer-kind-match-C1TuMgDc.js";
//#region src/routing/bound-account-read.ts
function resolveNormalizedBoundAccountMatch(binding) {
	const baseMatch = resolveNormalizedRouteBindingMatch(binding);
	const match = binding.match;
	if (!baseMatch || !match || typeof match !== "object") return null;
	const peerId = match.peer && typeof match.peer.id === "string" ? match.peer.id.trim() : void 0;
	const peerKind = match.peer ? normalizeChatType(match.peer.kind) : void 0;
	return {
		...baseMatch,
		peerId: peerId || void 0,
		peerKind: peerKind ?? void 0,
		guildId: normalizeRouteBindingId(match.guildId) || null,
		teamId: normalizeRouteBindingId(match.teamId) || null,
		roles: normalizeRouteBindingRoles(match.roles)
	};
}
function buildExactPeerIdSet(params) {
	const exactPeerIds = /* @__PURE__ */ new Set();
	const peerId = params.peerId?.trim();
	if (peerId) exactPeerIds.add(peerId);
	for (const alias of params.exactPeerIdAliases ?? []) {
		const trimmed = alias.trim();
		if (trimmed) exactPeerIds.add(trimmed);
	}
	return exactPeerIds;
}
function resolveFirstBoundAccountId(params) {
	const normalizedChannel = normalizeRouteBindingChannelId(params.channelId);
	if (!normalizedChannel) return;
	const normalizedAgentId = normalizeAgentId(params.agentId);
	const exactPeerIds = buildExactPeerIdSet({
		peerId: params.peerId?.trim() || void 0,
		exactPeerIdAliases: params.exactPeerIdAliases
	});
	const hasPeerContext = exactPeerIds.size > 0;
	const normalizedPeerKind = normalizeChatType(params.peerKind) ?? void 0;
	let wildcardPeerMatch;
	let channelOnlyFallback;
	for (const binding of listRouteBindings(params.cfg)) {
		const resolved = resolveNormalizedBoundAccountMatch(binding);
		if (!resolved || resolved.channelId !== normalizedChannel || resolved.agentId !== normalizedAgentId) continue;
		if (!routeBindingScopeMatches(resolved, {
			groupSpace: params.groupSpace,
			memberRoleIds: params.memberRoleIds
		})) continue;
		if (!hasPeerContext) return resolved.accountId;
		if (resolved.peerId === "*") {
			if (!resolved.peerKind || !normalizedPeerKind || !peerKindMatches(resolved.peerKind, normalizedPeerKind)) continue;
			wildcardPeerMatch ??= resolved.accountId;
		} else if (resolved.peerId) {
			if (resolved.peerKind && normalizedPeerKind && !peerKindMatches(resolved.peerKind, normalizedPeerKind)) continue;
			if (exactPeerIds.has(resolved.peerId)) return resolved.accountId;
		} else channelOnlyFallback ??= resolved.accountId;
	}
	return wildcardPeerMatch ?? channelOnlyFallback;
}
//#endregion
export { resolveFirstBoundAccountId as t };
