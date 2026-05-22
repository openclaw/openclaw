import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import { n as normalizeAccountId } from "./account-id-Bj7l9NI7.js";
import { c as normalizeAgentId } from "./session-key-C0K0uhmG.js";
import { r as normalizeChatChannelId } from "./ids-PHiL43bp.js";
//#region src/routing/binding-scope.ts
function normalizeRouteBindingId(value) {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" || typeof value === "bigint") return String(value).trim();
	return "";
}
function normalizeRouteBindingRoles(value) {
	return Array.isArray(value) && value.length > 0 ? value : null;
}
function normalizeRouteBindingChannelId(raw) {
	const normalized = normalizeChatChannelId(raw);
	if (normalized) return normalized;
	return normalizeLowercaseStringOrEmpty(raw) || null;
}
function resolveNormalizedRouteBindingMatch(binding) {
	if (!binding || typeof binding !== "object") return null;
	const match = binding.match;
	if (!match || typeof match !== "object") return null;
	const channelId = normalizeRouteBindingChannelId(match.channel);
	if (!channelId) return null;
	const accountId = typeof match.accountId === "string" ? match.accountId.trim() : "";
	if (!accountId || accountId === "*") return null;
	return {
		agentId: normalizeAgentId(binding.agentId),
		accountId: normalizeAccountId(accountId),
		channelId
	};
}
function scopeIdMatches(params) {
	if (!params.constraint) return true;
	return params.constraint === params.exact || params.constraint === params.groupSpace;
}
function hasRoleLookup(memberRoleIds) {
	return typeof memberRoleIds.has === "function";
}
function hasAnyRouteBindingRole(roles, memberRoleIds) {
	if (!memberRoleIds) return false;
	if (hasRoleLookup(memberRoleIds)) return roles.some((role) => memberRoleIds.has(role));
	const memberRoleIdSet = new Set(memberRoleIds);
	return roles.some((role) => memberRoleIdSet.has(role));
}
function routeBindingScopeMatches(constraint, scope) {
	const guildId = normalizeRouteBindingId(scope.guildId);
	const teamId = normalizeRouteBindingId(scope.teamId);
	const groupSpace = normalizeRouteBindingId(scope.groupSpace);
	if (!scopeIdMatches({
		constraint: constraint.guildId,
		exact: guildId,
		groupSpace
	})) return false;
	if (!scopeIdMatches({
		constraint: constraint.teamId,
		exact: teamId,
		groupSpace
	})) return false;
	const roles = normalizeRouteBindingRoles(constraint.roles);
	if (!roles) return true;
	return hasAnyRouteBindingRole(roles, scope.memberRoleIds);
}
//#endregion
export { routeBindingScopeMatches as a, resolveNormalizedRouteBindingMatch as i, normalizeRouteBindingId as n, normalizeRouteBindingRoles as r, normalizeRouteBindingChannelId as t };
