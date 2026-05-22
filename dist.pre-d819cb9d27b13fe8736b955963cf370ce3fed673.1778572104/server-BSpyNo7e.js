import { t as truncateCloseReason } from "./close-reason-H2COdmxK.js";
//#region src/gateway/server.ts
function emitStartupTrace(name, durationMs, totalMs) {
	if (!process.env.OPENCLAW_GATEWAY_STARTUP_TRACE) return;
	process.stderr.write(`[gateway] startup trace: ${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms\n`);
}
async function loadServerImpl() {
	const startupStartedAt = performance.now();
	const before = performance.now();
	try {
		return await import("./server.impl-DHwnauxu.js");
	} finally {
		const now = performance.now();
		emitStartupTrace("gateway.server-impl-import", now - before, now - startupStartedAt);
	}
}
async function startGatewayServer(...args) {
	return await (await loadServerImpl()).startGatewayServer(...args);
}
async function __resetModelCatalogCacheForTest() {
	await (await loadServerImpl()).__resetModelCatalogCacheForTest();
}
//#endregion
export { __resetModelCatalogCacheForTest, startGatewayServer, truncateCloseReason };
