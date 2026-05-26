import { i as OpenClawConfig } from "../types.openclaw-DIZy8jcb.js";
import { n as PluginMetadataSnapshot } from "../plugin-metadata-snapshot.types-B1XKSJMK.js";
//#region src/agents/models-config.d.ts
declare function ensureOpenClawModelsJson(config?: OpenClawConfig, agentDirOverride?: string, options?: {
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
  workspaceDir?: string;
  providerDiscoveryProviderIds?: readonly string[];
  providerDiscoveryTimeoutMs?: number;
  providerDiscoveryEntriesOnly?: boolean;
}): Promise<{
  agentDir: string;
  wrote: boolean;
}>;
//#endregion
export { ensureOpenClawModelsJson };