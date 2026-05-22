//#region extensions/whatsapp/src/connection-controller-registry.ts
const CONNECTION_REGISTRY_KEY = Symbol.for("openclaw.whatsapp.connectionControllerRegistry");
function getConnectionRegistryState() {
	const globalState = globalThis;
	const existing = globalState[CONNECTION_REGISTRY_KEY];
	if (existing) return existing;
	const created = { controllers: /* @__PURE__ */ new Map() };
	globalState[CONNECTION_REGISTRY_KEY] = created;
	return created;
}
function getRegisteredWhatsAppConnectionController(accountId) {
	return getConnectionRegistryState().controllers.get(accountId) ?? null;
}
function registerWhatsAppConnectionController(accountId, controller) {
	getConnectionRegistryState().controllers.set(accountId, controller);
}
function unregisterWhatsAppConnectionController(accountId, controller) {
	const controllers = getConnectionRegistryState().controllers;
	if (controllers.get(accountId) === controller) controllers.delete(accountId);
}
//#endregion
export { registerWhatsAppConnectionController as n, unregisterWhatsAppConnectionController as r, getRegisteredWhatsAppConnectionController as t };
