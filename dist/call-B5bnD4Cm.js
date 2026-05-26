import { i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES } from "./client-info-BVWE_ra1.js";
import { r as callGateway } from "./call-t1U2G3yY.js";
import { r as withProgress } from "./progress-CE2g1zbv.js";
//#region src/cli/gateway-cli/call.ts
const callGatewayCli = async (method, opts, params) => withProgress({
	label: `Gateway ${method}`,
	indeterminate: true,
	enabled: opts.json !== true
}, async () => await callGateway({
	config: opts.config,
	url: opts.url,
	token: opts.token,
	password: opts.password,
	method,
	params,
	expectFinal: Boolean(opts.expectFinal),
	timeoutMs: Number(opts.timeout ?? 1e4),
	clientName: GATEWAY_CLIENT_NAMES.CLI,
	mode: GATEWAY_CLIENT_MODES.CLI
}));
//#endregion
export { callGatewayCli };
