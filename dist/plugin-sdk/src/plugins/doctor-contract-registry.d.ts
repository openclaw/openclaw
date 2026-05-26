import type { LegacyConfigRule } from "../config/legacy.shared.js";
import type { OpenClawConfig } from "../config/types.js";
import type { DoctorSessionRouteStateOwner } from "./doctor-session-route-state-owner-types.js";
import { type PluginModuleLoaderFactory } from "./plugin-module-loader-cache.js";
export declare function collectRelevantDoctorPluginIds(raw: unknown): string[];
export declare function collectRelevantDoctorPluginIdsForTouchedPaths(params: {
    raw: unknown;
    touchedPaths: ReadonlyArray<ReadonlyArray<string>>;
}): string[];
export declare function clearPluginDoctorContractRegistryCache(): void;
export declare function setPluginDoctorContractRegistryModuleLoaderFactoryForTest(factory: PluginModuleLoaderFactory | undefined): void;
export declare function listPluginDoctorLegacyConfigRules(params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    pluginIds?: readonly string[];
}): LegacyConfigRule[];
export declare function listPluginDoctorSessionRouteStateOwners(params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    pluginIds?: readonly string[];
}): DoctorSessionRouteStateOwner[];
export declare function applyPluginDoctorCompatibilityMigrations(cfg: OpenClawConfig, params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    pluginIds?: readonly string[];
}): {
    config: OpenClawConfig;
    changes: string[];
};
