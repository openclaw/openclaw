import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginManifestCapabilityProviderAuthSignal, PluginManifestCapabilityProviderConfigSignal } from "./manifest.js";
export type ManifestConfigAvailabilitySignal = PluginManifestCapabilityProviderConfigSignal;
export type ManifestAuthAvailabilitySignal = PluginManifestCapabilityProviderAuthSignal;
export declare function manifestConfigSignalPasses(params: {
    config?: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    signal: ManifestConfigAvailabilitySignal;
}): boolean;
export declare function manifestProviderBaseUrlGuardPasses(params: {
    config?: OpenClawConfig;
    guard: ManifestAuthAvailabilitySignal["providerBaseUrl"];
}): boolean;
export declare function manifestPluginSetupProviderEnvVars(plugin: PluginManifestRecord, providerId: string): readonly string[];
export declare function hasNonEmptyManifestEnvCandidate(env: NodeJS.ProcessEnv, envVars: readonly string[]): boolean;
export declare function hasManifestToolAvailability(params: {
    plugin: PluginManifestRecord;
    toolNames: readonly string[];
    config?: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    hasAuthForProvider?: (providerId: string) => boolean;
}): boolean;
