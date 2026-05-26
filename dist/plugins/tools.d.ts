import { D as OpenClawPluginToolContext } from "../types-core-DxqEkbXr.js";
import { r as AnyAgentTool } from "../common-BDN0bXby.js";
//#region src/plugins/tool-descriptor-cache.d.ts
declare function resetPluginToolDescriptorCache(): void;
//#endregion
//#region src/plugins/tools.d.ts
type PluginToolMeta = {
  pluginId: string;
  optional: boolean;
};
declare function setPluginToolMeta(tool: AnyAgentTool, meta: PluginToolMeta): void;
declare function getPluginToolMeta(tool: AnyAgentTool): PluginToolMeta | undefined;
declare function copyPluginToolMeta(source: AnyAgentTool, target: AnyAgentTool): void;
/**
 * Builds a collision-proof key for plugin-owned tool metadata lookups.
 */
declare function buildPluginToolMetadataKey(pluginId: string, toolName: string): string;
declare function ensureStandalonePluginToolRegistryLoaded(params: {
  context: OpenClawPluginToolContext;
  toolAllowlist?: string[];
  toolDenylist?: string[];
  allowGatewaySubagentBinding?: boolean;
  hasAuthForProvider?: (providerId: string) => boolean;
  env?: NodeJS.ProcessEnv;
}): void;
declare function resolvePluginTools(params: {
  context: OpenClawPluginToolContext;
  existingToolNames?: Set<string>;
  toolAllowlist?: string[];
  toolDenylist?: string[];
  suppressNameConflicts?: boolean;
  allowGatewaySubagentBinding?: boolean;
  hasAuthForProvider?: (providerId: string) => boolean;
  env?: NodeJS.ProcessEnv;
}): AnyAgentTool[];
//#endregion
export { PluginToolMeta, buildPluginToolMetadataKey, copyPluginToolMeta, ensureStandalonePluginToolRegistryLoaded, getPluginToolMeta, resetPluginToolDescriptorCache, resetPluginToolDescriptorCache as resetPluginToolFactoryCache, resolvePluginTools, setPluginToolMeta };