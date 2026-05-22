import { s as normalizeStringEntries } from "./string-normalization-C5SGsaST.js";
//#region src/channels/allow-from.ts
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
export { resolveGroupAllowFromSources as i, isSenderIdAllowed as n, mergeDmAllowFromSources as r, firstDefined as t };
