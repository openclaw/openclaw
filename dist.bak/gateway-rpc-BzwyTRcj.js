import { h as GATEWAY_CLIENT_NAMES, m as GATEWAY_CLIENT_MODES } from "./message-channel-C0KMGsnJ.js";
import { n as callGateway } from "./call-BP56BqJF.js";
import { n as withProgress } from "./progress-_rXhKU7V.js";

//#region src/cli/gateway-rpc.ts
function addGatewayClientOptions(cmd) {
	return cmd.option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)").option("--token <token>", "Gateway token (if required)").option("--timeout <ms>", "Timeout in ms", "30000").option("--expect-final", "Wait for final response (agent)", false);
}
async function callGatewayFromCli(method, opts, params, extra) {
	const showProgress = extra?.progress ?? opts.json !== true;
	return await withProgress({
		label: `Gateway ${method}`,
		indeterminate: true,
		enabled: showProgress
	}, async () => await callGateway({
		url: opts.url,
		token: opts.token,
		method,
		params,
		expectFinal: extra?.expectFinal ?? Boolean(opts.expectFinal),
		timeoutMs: Number(opts.timeout ?? 1e4),
		clientName: GATEWAY_CLIENT_NAMES.CLI,
		mode: GATEWAY_CLIENT_MODES.CLI
	}));
}

//#endregion
export { callGatewayFromCli as n, addGatewayClientOptions as t };