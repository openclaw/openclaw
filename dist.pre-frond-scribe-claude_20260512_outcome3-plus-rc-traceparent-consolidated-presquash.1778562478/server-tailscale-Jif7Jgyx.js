import { i as formatErrorMessage } from "./errors-QN8rySzW.js";
import { i as enableTailscaleServe, n as disableTailscaleServe, o as getTailnetHostname, r as enableTailscaleFunnel, t as disableTailscaleFunnel } from "./tailscale-fQG1D895.js";
//#region src/gateway/server-tailscale.ts
async function startGatewayTailscaleExposure(params) {
	if (params.tailscaleMode === "off") return null;
	try {
		if (params.tailscaleMode === "serve") await enableTailscaleServe(params.port);
		else await enableTailscaleFunnel(params.port);
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
