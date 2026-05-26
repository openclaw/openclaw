//#region src/commands/status.gateway-connection.ts
function logGatewayConnectionDetails(params) {
	params.runtime.log(params.info("Gateway connection:"));
	for (const line of params.message.split("\n")) params.runtime.log(`  ${line}`);
	if (params.trailingBlankLine) params.runtime.log("");
}
function resolveStatusAllConnectionDetails(params) {
	if (params.nodeOnlyGateway) return params.nodeOnlyGateway.connectionDetails;
	if (!params.remoteUrlMissing) return params.gatewayConnection.message;
	return [
		"Gateway mode: remote",
		"Gateway target: (missing gateway.remote.url)",
		`Config: ${params.configPath}`,
		`Bind: ${params.bindMode ?? "loopback"}`,
		`Local fallback (used for probes): ${params.gatewayConnection.url}`,
		"Fix: set gateway.remote.url, or set gateway.mode=local."
	].join("\n");
}
//#endregion
export { resolveStatusAllConnectionDetails as n, logGatewayConnectionDetails as t };
