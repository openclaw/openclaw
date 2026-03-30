//#region src/channels/allow-from.ts
function mergeDmAllowFromSources(params) {
	const storeEntries = params.dmPolicy === "allowlist" ? [] : params.storeAllowFrom ?? [];
	return [...params.allowFrom ?? [], ...storeEntries].map((value) => String(value).trim()).filter(Boolean);
}
function resolveGroupAllowFromSources(params) {
	const explicitGroupAllowFrom = Array.isArray(params.groupAllowFrom) && params.groupAllowFrom.length > 0 ? params.groupAllowFrom : void 0;
	return (explicitGroupAllowFrom ? explicitGroupAllowFrom : params.fallbackToAllowFrom === false ? [] : params.allowFrom ?? []).map((value) => String(value).trim()).filter(Boolean);
}
function firstDefined(...values) {
	for (const value of values) if (typeof value !== "undefined") return value;
}
function isSenderIdAllowed(allow, senderId, allowWhenEmpty) {
	if (!allow.hasEntries) return allowWhenEmpty;
	if (allow.hasWildcard) return true;
	if (!senderId) return false;
	return allow.entries.includes(senderId);
}

//#endregion
export { resolveGroupAllowFromSources as i, isSenderIdAllowed as n, mergeDmAllowFromSources as r, firstDefined as t };