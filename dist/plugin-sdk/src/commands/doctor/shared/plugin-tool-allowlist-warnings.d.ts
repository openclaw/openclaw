import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../../../plugins/manifest-registry.js";
export declare function collectPluginToolAllowlistWarnings(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    manifestRegistry?: PluginManifestRegistry;
}): string[];
export declare function collectBundledProviderAllowlistPolicyWarnings(params: {
    cfg: OpenClawConfig;
}): string[];
