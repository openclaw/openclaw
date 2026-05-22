import { i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES } from "./client-info-1Q-QxpL0.js";
import { i as callGateway } from "./call-CTkOURQV.js";
import { r as withProgress } from "./progress-Ba4gvSqF.js";
//#region src/cli/nodes-cli/rpc.runtime.ts
async function callGatewayCliRuntime(method, opts, params, callOpts) {
	return await withProgress({
		label: `Nodes ${method}`,
		indeterminate: true,
		enabled: opts.json !== true
	}, async () => await callGateway({
		url: opts.url,
		token: opts.token,
		method,
		params,
		timeoutMs: callOpts?.transportTimeoutMs ?? Number(opts.timeout ?? 1e4),
		clientName: GATEWAY_CLIENT_NAMES.CLI,
		mode: GATEWAY_CLIENT_MODES.CLI
	}));
}
//#endregion
export { callGatewayCliRuntime };
