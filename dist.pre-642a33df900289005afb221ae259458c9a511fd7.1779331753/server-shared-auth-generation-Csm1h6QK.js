import { t as resolveGatewayReloadSettings } from "./config-reload-settings-BCSjTPm-.js";
//#region src/gateway/server-shared-auth-generation.ts
function disconnectStaleSharedGatewayAuthClients(params) {
	for (const gatewayClient of params.clients) {
		if (!gatewayClient.usesSharedGatewayAuth) continue;
		if (gatewayClient.sharedGatewaySessionGeneration === params.expectedGeneration) continue;
		try {
			gatewayClient.socket.close(4001, "gateway auth changed");
		} catch {}
	}
}
function disconnectAllSharedGatewayAuthClients(clients) {
	for (const gatewayClient of clients) {
		if (!gatewayClient.usesSharedGatewayAuth) continue;
		try {
			gatewayClient.socket.close(4001, "gateway auth changed");
		} catch {}
	}
}
function getRequiredSharedGatewaySessionGeneration(state) {
	return state.required === null ? state.current : state.required;
}
function setCurrentSharedGatewaySessionGeneration(state, nextGeneration) {
	const previousGeneration = state.current;
	state.current = nextGeneration;
	if (state.required === nextGeneration) {
		state.required = null;
		return;
	}
	if (state.required !== null && previousGeneration !== nextGeneration) state.required = null;
}
function enforceSharedGatewaySessionGenerationForConfigWrite(params) {
	const reloadMode = resolveGatewayReloadSettings(params.nextConfig).mode;
	const nextSharedGatewaySessionGeneration = params.resolveRuntimeSnapshotGeneration();
	if (reloadMode === "off") {
		params.state.current = nextSharedGatewaySessionGeneration;
		params.state.required = nextSharedGatewaySessionGeneration;
		disconnectStaleSharedGatewayAuthClients({
			clients: params.clients,
			expectedGeneration: nextSharedGatewaySessionGeneration
		});
		return;
	}
	params.state.required = null;
	setCurrentSharedGatewaySessionGeneration(params.state, nextSharedGatewaySessionGeneration);
	disconnectStaleSharedGatewayAuthClients({
		clients: params.clients,
		expectedGeneration: nextSharedGatewaySessionGeneration
	});
}
//#endregion
export { setCurrentSharedGatewaySessionGeneration as a, getRequiredSharedGatewaySessionGeneration as i, disconnectStaleSharedGatewayAuthClients as n, enforceSharedGatewaySessionGenerationForConfigWrite as r, disconnectAllSharedGatewayAuthClients as t };
