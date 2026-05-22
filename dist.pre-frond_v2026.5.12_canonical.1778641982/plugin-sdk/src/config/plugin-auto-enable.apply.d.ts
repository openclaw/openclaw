import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginAutoEnableCandidate, PluginAutoEnableResult } from "./plugin-auto-enable.types.js";
import type { OpenClawConfig } from "./types.openclaw.js";
export declare function materializePluginAutoEnableCandidates(params: {
    config?: OpenClawConfig;
    candidates: readonly PluginAutoEnableCandidate[];
    env?: NodeJS.ProcessEnv;
    manifestRegistry?: PluginManifestRegistry;
}): PluginAutoEnableResult;
export declare function applyPluginAutoEnable(params: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    manifestRegistry?: PluginManifestRegistry;
}): PluginAutoEnableResult;
