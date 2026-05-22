import type { PluginRuntime } from "./types.js";
type GatewaySubagentState = {
    subagent: PluginRuntime["subagent"] | undefined;
    nodes: PluginRuntime["nodes"] | undefined;
};
export declare const gatewaySubagentState: GatewaySubagentState;
/**
 * Set the process-global gateway subagent runtime.
 * Called during gateway startup so that gateway-bindable plugin runtimes can
 * resolve subagent methods dynamically even when their registry was cached
 * before the gateway finished loading plugins.
 */
export declare function setGatewaySubagentRuntime(subagent: PluginRuntime["subagent"]): void;
export declare function setGatewayNodesRuntime(nodes: PluginRuntime["nodes"]): void;
/**
 * Reset the process-global gateway subagent runtime.
 * Used by tests to avoid leaking gateway state across module reloads.
 */
export declare function clearGatewaySubagentRuntime(): void;
export {};
