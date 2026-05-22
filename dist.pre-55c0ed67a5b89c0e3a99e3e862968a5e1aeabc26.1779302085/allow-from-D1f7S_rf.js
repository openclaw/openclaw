import { s as normalizeStringEntries } from "./string-normalization-DiPHgdft.js";
//#region src/channels/allow-from.ts
const ACCESS_GROUP_ALLOW_FROM_PREFIX = "accessGroup:";
function parseAccessGroupAllowFromEntry(entry) {
	const trimmed = entry.trim();
	if (!trimmed.startsWith("accessGroup:")) return null;
	const name = trimmed.slice(12).trim();
	return name.length > 0 ? name : null;
}
function mergeDmAllowFromSources(params) {
	const storeEntries = params.dmPolicy === "allowlist" || params.dmPolicy === "open" ? [] : params.storeAllowFrom ?? [];
	return normalizeStringEntries([...params.allowFrom ?? [], ...storeEntries]);
}
function resolveGroupAllowFromSources(params) {
	const explicitGroupAllowFrom = Array.isArray(params.groupAllowFrom) && params.groupAllowFrom.length > 0 ? params.groupAllowFrom : void 0;
	return normalizeStringEntries(explicitGroupAllowFrom ? explicitGroupAllowFrom : params.fallbackToAllowFrom === false ? [] : params.allowFrom ?? []);
}
function firstDefined(...values) {
	for (const value of values) if (value !== void 0) return value;
}
function isSenderIdAllowed(allow, senderId, allowWhenEmpty) {
	if (!allow.hasEntries) return allowWhenEmpty;
	if (allow.hasWildcard) return true;
	if (!senderId) return false;
	return allow.entries.includes(senderId);
}
//#endregion
export { parseAccessGroupAllowFromEntry as a, mergeDmAllowFromSources as i, firstDefined as n, resolveGroupAllowFromSources as o, isSenderIdAllowed as r, ACCESS_GROUP_ALLOW_FROM_PREFIX as t };
