import { i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES } from "./client-info-CgOISqZp.js";
import { i as callGateway } from "./call-DO7ujqcl.js";
import { r as withProgress } from "./progress-Cw6xZlhJ.js";
//#region src/cli/gateway-rpc.runtime.ts
async function callGatewayFromCliRuntime(method, opts, params, extra) {
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
		deviceIdentity: extra?.deviceIdentity,
		expectFinal: extra?.expectFinal ?? Boolean(opts.expectFinal),
		scopes: extra?.scopes,
		timeoutMs: Number(opts.timeout ?? 1e4),
		clientName: extra?.clientName ?? GATEWAY_CLIENT_NAMES.CLI,
		mode: extra?.mode ?? GATEWAY_CLIENT_MODES.CLI
	}));
}
//#endregion
export { callGatewayFromCliRuntime };
