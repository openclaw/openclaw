import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
export declare function hasConfiguredWebSearchCredential(params: {
    config: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    searchConfig?: Record<string, unknown>;
    origin?: PluginManifestRecord["origin"];
    bundledAllowlistCompat?: boolean;
}): boolean;
