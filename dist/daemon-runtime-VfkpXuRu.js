//#region src/commands/daemon-runtime.ts
const DEFAULT_GATEWAY_DAEMON_RUNTIME = "node";
const GATEWAY_DAEMON_RUNTIME_OPTIONS = [{
	value: "node",
	label: "Node (recommended)",
	hint: "Required for WhatsApp + Telegram. Bun can corrupt memory on reconnect."
}];
function isGatewayDaemonRuntime(value) {
	return value === "node" || value === "bun";
}

//#endregion
export { GATEWAY_DAEMON_RUNTIME_OPTIONS as n, isGatewayDaemonRuntime as r, DEFAULT_GATEWAY_DAEMON_RUNTIME as t };