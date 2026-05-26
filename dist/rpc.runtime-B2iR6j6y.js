import { i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES } from "./client-info-CgOISqZp.js";
import { i as callGateway } from "./call-DO7ujqcl.js";
import { r as withProgress } from "./progress-Cw6xZlhJ.js";
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
