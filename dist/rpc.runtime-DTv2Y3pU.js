import { i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES } from "./client-info-BVWE_ra1.js";
import { r as callGateway } from "./call-t1U2G3yY.js";
import { r as withProgress } from "./progress-CE2g1zbv.js";
//#region src/cli/nodes-cli/rpc.runtime.ts
const NODE_PAIR_APPROVAL_GATEWAY_METHODS = new Set(["node.pair.list", "node.pair.approve"]);
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
async function callNodePairApprovalGatewayCliRuntime(method, opts, params, callOpts) {
	if (!NODE_PAIR_APPROVAL_GATEWAY_METHODS.has(method)) throw new Error(`unsupported node pair approval gateway method: ${method}`);
	return await withProgress({
		label: `Nodes ${method}`,
		indeterminate: true,
		enabled: opts.json !== true
	}, async () => await callGateway({
		url: opts.url,
		token: opts.token,
		method,
		params,
		timeoutMs: callOpts.transportTimeoutMs ?? Number(opts.timeout ?? 1e4),
		clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
		mode: GATEWAY_CLIENT_MODES.BACKEND,
		scopes: callOpts.scopes
	}));
}
//#endregion
export { callGatewayCliRuntime, callNodePairApprovalGatewayCliRuntime };
