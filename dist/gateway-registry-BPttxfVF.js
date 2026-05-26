//#region extensions/discord/src/monitor/presence-cache.ts
/**
* In-memory cache of Discord user presence data.
* Populated by PRESENCE_UPDATE gateway events when the GuildPresences intent is enabled.
* Per-account maps are capped to prevent unbounded growth (#4948).
*/
const MAX_PRESENCE_PER_ACCOUNT = 5e3;
const presenceCache = /* @__PURE__ */ new Map();
function resolveAccountKey$1(accountId) {
	return accountId ?? "default";
}
/** Update cached presence for a user. */
function setPresence(accountId, userId, data) {
	const accountKey = resolveAccountKey$1(accountId);
	let accountCache = presenceCache.get(accountKey);
	if (!accountCache) {
		accountCache = /* @__PURE__ */ new Map();
		presenceCache.set(accountKey, accountCache);
	}
	accountCache.set(userId, data);
	if (accountCache.size > MAX_PRESENCE_PER_ACCOUNT) {
		const oldest = accountCache.keys().next().value;
		if (oldest !== void 0) accountCache.delete(oldest);
	}
}
/** Get cached presence for a user. Returns undefined if not cached. */
function getPresence(accountId, userId) {
	return presenceCache.get(resolveAccountKey$1(accountId))?.get(userId);
}
/** Clear cached presence data. */
function clearPresences(accountId) {
	if (accountId) {
		presenceCache.delete(resolveAccountKey$1(accountId));
		return;
	}
	presenceCache.clear();
}
/** Get the number of cached presence entries. */
function presenceCacheSize() {
	let total = 0;
	for (const accountCache of presenceCache.values()) total += accountCache.size;
	return total;
}
//#endregion
//#region extensions/discord/src/monitor/gateway-registry.ts
/**
* Module-level registry of active Discord GatewayPlugin instances.
* Bridges the gap between agent tool handlers (which only have REST access)
* and the gateway WebSocket (needed for operations like updatePresence).
* Follows the same pattern as presence-cache.ts.
*/
const gatewayRegistry = /* @__PURE__ */ new Map();
const DEFAULT_ACCOUNT_KEY = "\0__default__";
function resolveAccountKey(accountId) {
	return accountId ?? DEFAULT_ACCOUNT_KEY;
}
/** Register a GatewayPlugin instance for an account. */
function registerGateway(accountId, gateway) {
	gatewayRegistry.set(resolveAccountKey(accountId), gateway);
}
/** Unregister a GatewayPlugin instance for an account. */
function unregisterGateway(accountId) {
	gatewayRegistry.delete(resolveAccountKey(accountId));
}
/** Get the GatewayPlugin for an account. Returns undefined if not registered. */
function getGateway(accountId) {
	return gatewayRegistry.get(resolveAccountKey(accountId));
}
/** Clear all registered gateways (for testing). */
function clearGateways() {
	gatewayRegistry.clear();
}
//#endregion
export { clearPresences as a, setPresence as c, unregisterGateway as i, getGateway as n, getPresence as o, registerGateway as r, presenceCacheSize as s, clearGateways as t };
