import type { OpenClawConfig } from "../config/types.js";
import { createPluginActivationSource, normalizePluginsConfig } from "../plugins/config-state.js";
import { type PluginManifestRecord } from "../plugins/manifest-registry.js";
export type FacadePluginManifestLike = Pick<PluginManifestRecord, "id" | "origin" | "enabledByDefault" | "enabledByDefaultOnPlatforms" | "rootDir" | "channels">;
type FacadeModuleLocation = {
    modulePath: string;
    boundaryRoot: string;
};
export declare function resolveRegistryPluginModuleLocation(params: {
    dirName: string;
    artifactBasename: string;
    resolutionKey: string;
    env?: NodeJS.ProcessEnv;
}): FacadeModuleLocation | null;
export declare function resolveTrackedFacadePluginId(params: {
    dirName: string;
    artifactBasename: string;
    location: FacadeModuleLocation | null;
    sourceExtensionsRoot: string;
    resolutionKey: string;
    env?: NodeJS.ProcessEnv;
}): string;
export declare function resolveBundledPluginPublicSurfaceAccess(params: {
    dirName: string;
    artifactBasename: string;
    location: FacadeModuleLocation | null;
    sourceExtensionsRoot: string;
    resolutionKey: string;
    env?: NodeJS.ProcessEnv;
}): {
    allowed: boolean;
    pluginId?: string;
    reason?: string;
};
export declare function evaluateBundledPluginPublicSurfaceAccess(params: {
    params: {
        dirName: string;
        artifactBasename: string;
    };
    manifestRecord: FacadePluginManifestLike;
    config: OpenClawConfig;
    normalizedPluginsConfig: ReturnType<typeof normalizePluginsConfig>;
    activationSource: ReturnType<typeof createPluginActivationSource>;
    autoEnabledReasons: Record<string, string[]>;
}): {
    allowed: boolean;
    pluginId?: string;
    reason?: string;
};
export declare function throwForBundledPluginPublicSurfaceAccess(params: {
    access: {
        allowed: boolean;
        pluginId?: string;
        reason?: string;
    };
    request: {
        dirName: string;
        artifactBasename: string;
    };
}): never;
export declare function resolveActivatedBundledPluginPublicSurfaceAccessOrThrow(params: {
    dirName: string;
    artifactBasename: string;
    location: FacadeModuleLocation | null;
    sourceExtensionsRoot: string;
    resolutionKey: string;
    env?: NodeJS.ProcessEnv;
}): {
    allowed: boolean;
    pluginId?: string;
    reason?: string;
};
export {};
