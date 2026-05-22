import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawPluginToolContext } from "./types.js";
export { resetPluginToolDescriptorCache, resetPluginToolDescriptorCache as resetPluginToolFactoryCache, } from "./tool-descriptor-cache.js";
export type PluginToolMeta = {
    pluginId: string;
    optional: boolean;
};
export declare function setPluginToolMeta(tool: AnyAgentTool, meta: PluginToolMeta): void;
export declare function getPluginToolMeta(tool: AnyAgentTool): PluginToolMeta | undefined;
export declare function copyPluginToolMeta(source: AnyAgentTool, target: AnyAgentTool): void;
/**
 * Builds a collision-proof key for plugin-owned tool metadata lookups.
 */
export declare function buildPluginToolMetadataKey(pluginId: string, toolName: string): string;
export declare function ensureStandalonePluginToolRegistryLoaded(params: {
    context: OpenClawPluginToolContext;
    toolAllowlist?: string[];
    toolDenylist?: string[];
    allowGatewaySubagentBinding?: boolean;
    hasAuthForProvider?: (providerId: string) => boolean;
    env?: NodeJS.ProcessEnv;
}): void;
export declare function resolvePluginTools(params: {
    context: OpenClawPluginToolContext;
    existingToolNames?: Set<string>;
    toolAllowlist?: string[];
    toolDenylist?: string[];
    suppressNameConflicts?: boolean;
    allowGatewaySubagentBinding?: boolean;
    hasAuthForProvider?: (providerId: string) => boolean;
    env?: NodeJS.ProcessEnv;
}): AnyAgentTool[];
