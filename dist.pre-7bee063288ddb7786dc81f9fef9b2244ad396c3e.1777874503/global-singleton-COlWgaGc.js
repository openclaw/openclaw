//#region src/shared/global-singleton.ts
function resolveGlobalSingleton(key, create) {
	const globalStore = globalThis;
	if (Object.prototype.hasOwnProperty.call(globalStore, key)) return globalStore[key];
	const created = create();
	globalStore[key] = created;
	return created;
}
function resolveGlobalMap(key) {
	return resolveGlobalSingleton(key, () => /* @__PURE__ */ new Map());
}
//#endregion
export { resolveGlobalSingleton as n, resolveGlobalMap as t };
