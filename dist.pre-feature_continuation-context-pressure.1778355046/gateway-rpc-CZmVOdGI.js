import { t as createLazyImportLoader } from "./lazy-promise-AiZRy56y.js";
//#region src/cli/gateway-rpc.ts
const gatewayRpcRuntimeLoader = createLazyImportLoader(() => import("./gateway-rpc.runtime.js"));
async function loadGatewayRpcRuntime() {
	return gatewayRpcRuntimeLoader.load();
}
function addGatewayClientOptions(cmd) {
	return cmd.option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)").option("--token <token>", "Gateway token (if required)").option("--timeout <ms>", "Timeout in ms", "30000").option("--expect-final", "Wait for final response (agent)", false);
}
async function callGatewayFromCli(method, opts, params, extra) {
	return await (await loadGatewayRpcRuntime()).callGatewayFromCliRuntime(method, opts, params, extra);
}
//#endregion
export { callGatewayFromCli as n, addGatewayClientOptions as t };
