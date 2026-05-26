import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
//#region src/gateway/server-model-catalog.ts
function createGatewayModelCatalogCache() {
	return {
		lastSuccessfulCatalog: null,
		inFlightRefresh: null,
		staleGeneration: 0,
		appliedGeneration: 0
	};
}
const readOnlyModelCatalogCache = createGatewayModelCatalogCache();
const fullModelCatalogCache = createGatewayModelCatalogCache();
function resolveGatewayModelCatalogCache(params) {
	return params?.readOnly === false ? fullModelCatalogCache : readOnlyModelCatalogCache;
}
function resetGatewayModelCatalogState() {
	for (const cache of [readOnlyModelCatalogCache, fullModelCatalogCache]) {
		cache.lastSuccessfulCatalog = null;
		cache.inFlightRefresh = null;
		cache.staleGeneration = 0;
		cache.appliedGeneration = 0;
	}
}
function isGatewayModelCatalogStale(cache) {
	return cache.appliedGeneration < cache.staleGeneration;
}
async function resolveLoadModelCatalog(params) {
	if (params?.loadModelCatalog) return params.loadModelCatalog;
	const { loadModelCatalog } = await import("./model-catalog-BjZ8JZNF.js");
	return loadModelCatalog;
}
function startGatewayModelCatalogRefresh(params) {
	const cache = resolveGatewayModelCatalogCache(params);
	const config = (params?.getConfig ?? getRuntimeConfig)();
	const readOnly = params?.readOnly !== false;
	const refreshGeneration = cache.staleGeneration;
	const refresh = resolveLoadModelCatalog(params).then((loadModelCatalog) => loadModelCatalog({
		config,
		readOnly
	})).then((catalog) => {
		if ((readOnly || catalog.length > 0) && refreshGeneration === cache.staleGeneration) {
			cache.lastSuccessfulCatalog = catalog;
			cache.appliedGeneration = cache.staleGeneration;
		}
		return catalog;
	}).finally(() => {
		if (cache.inFlightRefresh === refresh) cache.inFlightRefresh = null;
	});
	cache.inFlightRefresh = refresh;
	return refresh;
}
function markGatewayModelCatalogStaleForReload() {
	readOnlyModelCatalogCache.staleGeneration += 1;
	fullModelCatalogCache.staleGeneration += 1;
}
async function resetModelCatalogCacheForTest() {
	resetGatewayModelCatalogState();
	const { resetModelCatalogCacheForTest } = await import("./model-catalog-BjZ8JZNF.js");
	resetModelCatalogCacheForTest();
}
async function loadGatewayModelCatalog(params) {
	const cache = resolveGatewayModelCatalogCache(params);
	const isStale = isGatewayModelCatalogStale(cache);
	if (!isStale && cache.lastSuccessfulCatalog !== null) return cache.lastSuccessfulCatalog;
	if (isStale && cache.lastSuccessfulCatalog !== null) {
		if (!cache.inFlightRefresh) startGatewayModelCatalogRefresh(params).catch(() => void 0);
		return cache.lastSuccessfulCatalog;
	}
	if (cache.inFlightRefresh) return await cache.inFlightRefresh;
	return await startGatewayModelCatalogRefresh(params);
}
//#endregion
export { markGatewayModelCatalogStaleForReload as n, resetModelCatalogCacheForTest as r, loadGatewayModelCatalog as t };
