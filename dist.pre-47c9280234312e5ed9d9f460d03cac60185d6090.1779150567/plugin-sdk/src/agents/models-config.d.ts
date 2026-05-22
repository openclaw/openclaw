import { type OpenClawConfig } from "../config/config.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
export { resetModelsJsonReadyCacheForTest } from "./models-config-state.js";
export declare function ensureModelsFileModeForModelsJson(pathname: string): Promise<void>;
export declare function writeModelsFileAtomicForModelsJson(targetPath: string, contents: string): Promise<void>;
export declare function ensureOpenClawModelsJson(config?: OpenClawConfig, agentDirOverride?: string, options?: {
    pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
    workspaceDir?: string;
    providerDiscoveryProviderIds?: readonly string[];
    providerDiscoveryTimeoutMs?: number;
    providerDiscoveryEntriesOnly?: boolean;
}): Promise<{
    agentDir: string;
    wrote: boolean;
}>;
