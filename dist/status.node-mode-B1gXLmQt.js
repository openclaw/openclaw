import "./paths-Cw7f9XhU.js";
import { n as loadNodeHostConfig } from "./config-8XvG4BiT.js";
//#region src/commands/status.node-mode.ts
function resolveNodeGatewayTarget(gateway) {
	return gateway?.host ? `${gateway.host}:${gateway.port ?? 18789}` : "(gateway address unknown)";
}
function hasRunningRuntime(runtime) {
	return runtime?.status === "running" || typeof runtime?.pid === "number";
}
function isNodeServiceActive(node) {
	if (node.installed !== true) return false;
	if (node.externallyManaged === true) return true;
	if (node.loaded === true) return true;
	if (hasRunningRuntime(node.runtime)) return true;
	return typeof node.runtimeShort === "string" && node.runtimeShort.startsWith("running");
}
async function resolveNodeOnlyGatewayInfo(params) {
	if (params.daemon.installed !== false || !isNodeServiceActive(params.node)) return null;
	const gatewayTarget = resolveNodeGatewayTarget((await loadNodeHostConfig())?.gateway);
	return {
		gatewayTarget,
		gatewayValue: `node → ${gatewayTarget} · no local gateway`,
		connectionDetails: [
			"Node-only mode detected",
			"Local gateway: not expected on this machine",
			`Remote gateway target: ${gatewayTarget}`,
			"Inspect the remote gateway host for live channel and health details."
		].join("\n")
	};
}
//#endregion
export { resolveNodeOnlyGatewayInfo as t };
