//#region src/agents/pi-embedded-runner/sandbox-info.ts
function resolveEmbeddedFullAccessState(params) {
	if (params.execElevated?.fullAccessAvailable === true) return { available: true };
	if (params.execElevated?.fullAccessAvailable === false) return {
		available: false,
		blockedReason: params.execElevated.fullAccessBlockedReason ?? "host-policy"
	};
	if (!params.execElevated?.enabled || !params.execElevated.allowed) return {
		available: false,
		blockedReason: "host-policy"
	};
	return { available: true };
}
function buildEmbeddedSandboxInfo(sandbox, execElevated) {
	if (!sandbox?.enabled) return;
	const elevatedConfigured = execElevated?.enabled === true;
	const elevatedAllowed = Boolean(execElevated?.enabled && execElevated.allowed);
	const fullAccess = resolveEmbeddedFullAccessState({ execElevated });
	return {
		enabled: true,
		workspaceDir: sandbox.workspaceDir,
		containerWorkspaceDir: sandbox.containerWorkdir,
		workspaceAccess: sandbox.workspaceAccess,
		agentWorkspaceMount: sandbox.workspaceAccess === "ro" ? "/agent" : void 0,
		browserBridgeUrl: sandbox.browser?.bridgeUrl,
		hostBrowserAllowed: sandbox.browserAllowHostControl,
		...elevatedConfigured ? { elevated: {
			allowed: elevatedAllowed,
			defaultLevel: execElevated?.defaultLevel ?? "off",
			fullAccessAvailable: fullAccess.available,
			...fullAccess.blockedReason ? { fullAccessBlockedReason: fullAccess.blockedReason } : {}
		} } : {}
	};
}
//#endregion
export { resolveEmbeddedFullAccessState as n, buildEmbeddedSandboxInfo as t };
