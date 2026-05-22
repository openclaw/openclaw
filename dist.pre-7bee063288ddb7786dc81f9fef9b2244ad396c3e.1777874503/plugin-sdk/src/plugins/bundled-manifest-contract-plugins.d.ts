import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type PluginActivationBundledCompatMode } from "./activation-context.js";
import type { PluginManifestContractListKey, PluginManifestRecord } from "./manifest-registry.js";
export declare function listBundledManifestContractPluginIds(params: {
    plugins: readonly PluginManifestRecord[];
    contract: PluginManifestContractListKey;
    onlyPluginIds?: readonly string[];
}): string[];
export declare function resolveEnabledBundledManifestContractPlugins(params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    onlyPluginIds?: readonly string[];
    contract: PluginManifestContractListKey;
    compatMode: PluginActivationBundledCompatMode;
}): PluginManifestRecord[];
