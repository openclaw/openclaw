import { v as defaultRuntime } from "./entry.js";
import { t as formatCliCommand } from "./command-format-CDHXQh1_.js";
import { f as resolveGatewaySystemdServiceName, l as resolveGatewayLaunchAgentLabel, p as resolveGatewayWindowsTaskName } from "./constants-ChJK8ZR-.js";
import { t as resolveGatewayService } from "./service-BYZQINUW.js";

//#region src/cli/gateway-cli/shared.ts
const toOptionString = (value) => {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "bigint") return value.toString();
};
function describeUnknownError(err) {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	if (typeof err === "number" || typeof err === "bigint") return err.toString();
	if (typeof err === "boolean") return err ? "true" : "false";
	if (err && typeof err === "object") {
		if ("message" in err && typeof err.message === "string") return err.message;
		try {
			return JSON.stringify(err);
		} catch {
			return "Unknown error";
		}
	}
	return "Unknown error";
}
function extractGatewayMiskeys(parsed) {
	if (!parsed || typeof parsed !== "object") return {
		hasGatewayToken: false,
		hasRemoteToken: false
	};
	const gateway = parsed.gateway;
	if (!gateway || typeof gateway !== "object") return {
		hasGatewayToken: false,
		hasRemoteToken: false
	};
	const hasGatewayToken = "token" in gateway;
	const remote = gateway.remote;
	return {
		hasGatewayToken,
		hasRemoteToken: remote && typeof remote === "object" ? "token" in remote : false
	};
}
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
export { toOptionString as i, extractGatewayMiskeys as n, maybeExplainGatewayServiceStop as r, describeUnknownError as t };