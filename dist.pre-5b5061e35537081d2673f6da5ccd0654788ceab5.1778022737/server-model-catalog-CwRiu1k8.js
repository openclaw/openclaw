import { i as getRuntimeConfig } from "./io-BD1XQ5lD.js";
//#region src/gateway/server-model-catalog.ts
let lastSuccessfulCatalog = null;
let inFlightRefresh = null;
let staleGeneration = 0;
let appliedGeneration = 0;
function resetGatewayModelCatalogState() {
	lastSuccessfulCatalog = null;
	inFlightRefresh = null;
	staleGeneration = 0;
	appliedGeneration = 0;
}
function isGatewayModelCatalogStale() {
	return appliedGeneration < staleGeneration;
}
async function resolveLoadModelCatalog(params) {
	if (params?.loadModelCatalog) return params.loadModelCatalog;
	const { loadModelCatalog } = await import("./model-catalog-LABwHgj0.js");
	return loadModelCatalog;
}
function startGatewayModelCatalogRefresh(params) {
	const config = (params?.getConfig ?? getRuntimeConfig)();
	const refreshGeneration = staleGeneration;
	const refresh = resolveLoadModelCatalog(params).then((loadModelCatalog) => loadModelCatalog({ config })).then((catalog) => {
		if (catalog.length > 0 && refreshGeneration === staleGeneration) {
			lastSuccessfulCatalog = catalog;
			appliedGeneration = staleGeneration;
		}
		return catalog;
	}).finally(() => {
		if (inFlightRefresh === refresh) inFlightRefresh = null;
	});
	inFlightRefresh = refresh;
	return refresh;
}
function markGatewayModelCatalogStaleForReload() {
	staleGeneration += 1;
}
async function __resetModelCatalogCacheForTest() {
	resetGatewayModelCatalogState();
	const { resetModelCatalogCacheForTest } = await import("./model-catalog-LABwHgj0.js");
	resetModelCatalogCacheForTest();
}
async function loadGatewayModelCatalog(params) {
	const isStale = isGatewayModelCatalogStale();
	if (!isStale && lastSuccessfulCatalog) return lastSuccessfulCatalog;
	if (isStale && lastSuccessfulCatalog) {
		if (!inFlightRefresh) startGatewayModelCatalogRefresh(params).catch(() => void 0);
		return lastSuccessfulCatalog;
	}
	if (inFlightRefresh) return await inFlightRefresh;
	return await startGatewayModelCatalogRefresh(params);
}
//#endregion
export { loadGatewayModelCatalog as n, markGatewayModelCatalogStaleForReload as r, __resetModelCatalogCacheForTest as t };
