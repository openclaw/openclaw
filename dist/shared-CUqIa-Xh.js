import { t as formatCliCommand } from "./command-format-OwPqnbXG.js";
import { d as resolveGatewayLaunchAgentLabel, m as resolveGatewayWindowsTaskName, p as resolveGatewaySystemdServiceName } from "./paths-CBMC-f_X.js";
import { n as defaultRuntime } from "./runtime-DDH_zqCr.js";
import { i as resolveGatewayService } from "./service-ZFeJibwt.js";
//#region src/cli/gateway-cli/shared.ts
function renderGatewayServiceStopHints(env = process.env) {
	const profile = env.OPENCLAW_PROFILE;
	switch (process.platform) {
		case "darwin": return [`Tip: ${formatCliCommand("openclaw gateway stop")}`, `Or: launchctl bootout gui/$UID/${resolveGatewayLaunchAgentLabel(profile)}`];
		case "linux": return [`Tip: ${formatCliCommand("openclaw gateway stop")}`, `Or: systemctl --user stop ${resolveGatewaySystemdServiceName(profile)}.service`];
		case "win32": return [`Tip: ${formatCliCommand("openclaw gateway stop")}`, `Or: schtasks /End /TN "${resolveGatewayWindowsTaskName(profile)}"`];
		default: return [`Tip: ${formatCliCommand("openclaw gateway stop")}`];
	}
}
async function maybeExplainGatewayServiceStop() {
	const service = resolveGatewayService();
	let loaded = null;
	try {
		loaded = await service.isLoaded({ env: process.env });
	} catch {
		loaded = null;
	}
	if (loaded === false) return;
	defaultRuntime.error(loaded ? `Gateway service appears ${service.loadedText}. Stop it first.` : "Gateway service status unknown; if supervised, stop it first.");
	for (const hint of renderGatewayServiceStopHints()) defaultRuntime.error(hint);
}
//#endregion
export { maybeExplainGatewayServiceStop };
