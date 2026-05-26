import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { i as enableTailscaleServe, n as disableTailscaleServe, o as getTailnetHostname, r as enableTailscaleFunnel, s as hasTailscaleFunnelRouteForPort, t as disableTailscaleFunnel } from "./tailscale-BvtowUdS.js";
//#region src/gateway/server-tailscale.ts
async function startGatewayTailscaleExposure(params) {
	if (params.tailscaleMode === "off") return null;
	try {
		if (params.tailscaleMode === "serve") {
			if (params.preserveFunnel === true) {
				if (await hasTailscaleFunnelRouteForPort(params.port)) {
					const resetSuffix = params.resetOnExit ? "; resetOnExit is a no-op because no Serve route was applied this run" : "";
					params.logTailscale.info(`serve skipped: preserving externally configured Tailscale Funnel for port ${params.port}${resetSuffix}`);
					return null;
				}
			}
			await enableTailscaleServe(params.port);
		} else await enableTailscaleFunnel(params.port);
		const host = await getTailnetHostname().catch(() => null);
		if (host) {
			const uiPath = params.controlUiBasePath ? `${params.controlUiBasePath}/` : "/";
			params.logTailscale.info(`${params.tailscaleMode} enabled: https://${host}${uiPath} (WS via wss://${host})`);
		} else params.logTailscale.info(`${params.tailscaleMode} enabled`);
	} catch (err) {
		params.logTailscale.warn(`${params.tailscaleMode} failed: ${formatErrorMessage(err)}`);
	}
	if (!params.resetOnExit) return null;
	return async () => {
		try {
			if (params.tailscaleMode === "serve") await disableTailscaleServe();
			else await disableTailscaleFunnel();
		} catch (err) {
			params.logTailscale.warn(`${params.tailscaleMode} cleanup failed: ${formatErrorMessage(err)}`);
		}
	};
}
//#endregion
export { startGatewayTailscaleExposure };
