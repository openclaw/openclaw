import { tn as withProgress, zd as callGateway } from "./auth-profiles-DAOR1fRn.js";
import { En as GATEWAY_CLIENT_NAMES, Tn as GATEWAY_CLIENT_MODES } from "./method-scopes-CLHNYIU6.js";
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
