import { n as resolveGlobalSingleton } from "./global-singleton-DZyLAEQq.js";
const gatewaySubagentState = resolveGlobalSingleton(Symbol.for("openclaw.plugin.gatewaySubagentRuntime"), () => ({
	subagent: void 0,
	nodes: void 0
}));
/**
* Set the process-global gateway subagent runtime.
* Called during gateway startup so that gateway-bindable plugin runtimes can
* resolve subagent methods dynamically even when their registry was cached
* before the gateway finished loading plugins.
*/
function setGatewaySubagentRuntime(subagent) {
	gatewaySubagentState.subagent = subagent;
}
function setGatewayNodesRuntime(nodes) {
	gatewaySubagentState.nodes = nodes;
}
/**
* Reset the process-global gateway subagent runtime.
* Used by tests to avoid leaking gateway state across module reloads.
*/
function clearGatewaySubagentRuntime() {
	gatewaySubagentState.subagent = void 0;
	gatewaySubagentState.nodes = void 0;
}
//#endregion
export { setGatewaySubagentRuntime as i, gatewaySubagentState as n, setGatewayNodesRuntime as r, clearGatewaySubagentRuntime as t };
