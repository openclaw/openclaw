import { type PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginAutoEnableCandidate, PluginAutoEnableResult } from "./plugin-auto-enable.types.js";
import type { OpenClawConfig } from "./types.openclaw.js";
export type { PluginAutoEnableCandidate, PluginAutoEnableResult, } from "./plugin-auto-enable.types.js";
export declare function configMayNeedPluginAutoEnable(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): boolean;
export declare function resolvePluginAutoEnableReadiness(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): {
    mayNeedAutoEnable: boolean;
    configuredChannelIds: string[];
};
export declare function resolvePluginAutoEnableCandidateReason(candidate: PluginAutoEnableCandidate): string;
export declare function resolveConfiguredPluginAutoEnableCandidates(params: {
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    registry: PluginManifestRegistry;
    configuredChannelIds?: readonly string[];
}): PluginAutoEnableCandidate[];
export declare function resolvePluginAutoEnableManifestRegistry(params: {
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    manifestRegistry?: PluginManifestRegistry;
}): PluginManifestRegistry;
export declare function materializePluginAutoEnableCandidatesInternal(params: {
    config?: OpenClawConfig;
    candidates: readonly PluginAutoEnableCandidate[];
    env: NodeJS.ProcessEnv;
    manifestRegistry: PluginManifestRegistry;
}): PluginAutoEnableResult;
