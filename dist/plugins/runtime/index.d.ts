import { n as PluginRuntime, t as CreatePluginRuntimeOptions } from "../../types-DpjQFFwi.js";

//#region src/plugins/runtime/gateway-bindings.d.ts
/**
 * Set the process-global gateway subagent runtime.
 * Called during gateway startup so that gateway-bindable plugin runtimes can
 * resolve subagent methods dynamically even when their registry was cached
 * before the gateway finished loading plugins.
 */
declare function setGatewaySubagentRuntime(subagent: PluginRuntime["subagent"]): void;
declare function setGatewayNodesRuntime(nodes: PluginRuntime["nodes"]): void;
/**
 * Reset the process-global gateway subagent runtime.
 * Used by tests to avoid leaking gateway state across module reloads.
 */
declare function clearGatewaySubagentRuntime(): void;
//#endregion
//#region src/plugins/runtime/index.d.ts
declare function createPluginRuntime(_options?: CreatePluginRuntimeOptions): PluginRuntime;
//#endregion
export { type CreatePluginRuntimeOptions, type PluginRuntime, clearGatewaySubagentRuntime, createPluginRuntime, setGatewayNodesRuntime, setGatewaySubagentRuntime };