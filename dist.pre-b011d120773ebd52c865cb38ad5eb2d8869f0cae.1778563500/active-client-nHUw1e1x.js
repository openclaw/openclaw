import { n as normalizeAccountId } from "./account-id-Bj7l9NI7.js";
//#region extensions/matrix/src/matrix/active-client.ts
const activeClients = /* @__PURE__ */ new Map();
function resolveAccountKey(accountId) {
	return normalizeAccountId(accountId) || "default";
}
function setActiveMatrixClient(client, accountId) {
	const key = resolveAccountKey(accountId);
	if (!client) {
		activeClients.delete(key);
		return;
	}
	activeClients.set(key, client);
}
function getActiveMatrixClient(accountId) {
	const key = resolveAccountKey(accountId);
	return activeClients.get(key) ?? null;
}
//#endregion
export { setActiveMatrixClient as n, getActiveMatrixClient as t };
