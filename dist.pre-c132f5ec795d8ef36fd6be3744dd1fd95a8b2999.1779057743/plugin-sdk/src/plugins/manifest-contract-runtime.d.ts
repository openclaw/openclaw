import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestContractListKey } from "./manifest-registry.js";
export type ManifestContractRuntimePluginResolution = {
    pluginIds: string[];
    bundledCompatPluginIds: string[];
};
export declare function resolveManifestContractRuntimePluginResolution(params: {
    cfg?: OpenClawConfig;
    contract: PluginManifestContractListKey;
    value?: string;
}): ManifestContractRuntimePluginResolution;
