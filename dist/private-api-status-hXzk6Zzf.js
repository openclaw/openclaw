//#region extensions/imessage/src/private-api-status.ts
const FOUNDATIONAL_RPC_METHODS = new Set([
	"chats.list",
	"messages.history",
	"watch.subscribe",
	"watch.unsubscribe",
	"send"
]);
const bridgeStatusCache = /* @__PURE__ */ new Map();
function normalizeCliPath(cliPath) {
	return cliPath?.trim() || "imsg";
}
function imessageRpcSupportsMethod(status, method) {
	if (!status?.available) return false;
	if (status.rpcMethods.length === 0) return FOUNDATIONAL_RPC_METHODS.has(method);
	return status.rpcMethods.includes(method);
}
function getCachedIMessagePrivateApiStatus(cliPath) {
	const key = normalizeCliPath(cliPath);
	const entry = bridgeStatusCache.get(key);
	if (!entry) return;
	if (entry.expiresAt > 0 && entry.expiresAt < Date.now()) {
		bridgeStatusCache.delete(key);
		return;
	}
	return entry.status;
}
function setCachedIMessagePrivateApiStatus(cliPath, status, expiresAt = 0) {
	bridgeStatusCache.set(normalizeCliPath(cliPath), {
		status,
		expiresAt
	});
}
//#endregion
export { imessageRpcSupportsMethod as n, setCachedIMessagePrivateApiStatus as r, getCachedIMessagePrivateApiStatus as t };
