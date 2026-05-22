//#region src/plugin-sdk/memory-host-search.ts
async function loadMemoryHostSearchRuntime() {
	return await import("./memory-host-search.runtime.js");
}
async function getActiveMemorySearchManager(params) {
	return await (await loadMemoryHostSearchRuntime()).getActiveMemorySearchManager(params);
}
async function closeActiveMemorySearchManagers(cfg) {
	await (await loadMemoryHostSearchRuntime()).closeActiveMemorySearchManagers(cfg);
}
async function closeActiveMemorySearchManager(params) {
	await (await loadMemoryHostSearchRuntime()).closeActiveMemorySearchManager(params);
}
//#endregion
export { closeActiveMemorySearchManagers as n, getActiveMemorySearchManager as r, closeActiveMemorySearchManager as t };
