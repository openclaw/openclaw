import { type FacadeModuleLocation } from "./facade-loader.js";
import { resolveRegistryPluginModuleLocationFromRecords } from "./facade-resolution-shared.js";
export { createLazyFacadeArrayValue, createLazyFacadeObjectValue, listImportedBundledPluginFacadeIds, } from "./facade-loader.js";
export declare function createLazyFacadeValue<TFacade extends object, K extends keyof TFacade>(loadFacadeModule: () => TFacade, key: K): TFacade[K];
declare function resolveFacadeModuleLocation(params: {
    dirName: string;
    artifactBasename: string;
    env?: NodeJS.ProcessEnv;
}): {
    modulePath: string;
    boundaryRoot: string;
} | null;
type BundledPluginPublicSurfaceParams = {
    dirName: string;
    artifactBasename: string;
    env?: NodeJS.ProcessEnv;
};
type FacadeActivationCheckRuntimeModule = typeof import("./facade-activation-check.runtime.js");
declare function loadFacadeModuleAtLocationSync<T extends object>(params: {
    location: FacadeModuleLocation;
    trackedPluginId: string | (() => string);
    runtimeDeps?: {
        pluginId: string;
        env?: NodeJS.ProcessEnv;
    };
    loadModule?: (modulePath: string) => T;
}): T;
export declare function loadBundledPluginPublicSurfaceModuleSync<T extends object>(params: BundledPluginPublicSurfaceParams): T;
export declare function canLoadActivatedBundledPluginPublicSurface(params: {
    dirName: string;
    artifactBasename: string;
    env?: NodeJS.ProcessEnv;
}): boolean;
export declare function loadActivatedBundledPluginPublicSurfaceModuleSync<T extends object>(params: {
    dirName: string;
    artifactBasename: string;
    env?: NodeJS.ProcessEnv;
}): T;
export declare function tryLoadActivatedBundledPluginPublicSurfaceModuleSync<T extends object>(params: {
    dirName: string;
    artifactBasename: string;
    env?: NodeJS.ProcessEnv;
}): T | null;
export declare function resetFacadeRuntimeStateForTest(): void;
export declare const __testing: {
    loadFacadeModuleAtLocationSync: typeof loadFacadeModuleAtLocationSync;
    resolveRegistryPluginModuleLocationFromRegistry: typeof resolveRegistryPluginModuleLocationFromRecords;
    resolveFacadeModuleLocation: typeof resolveFacadeModuleLocation;
    evaluateBundledPluginPublicSurfaceAccess: FacadeActivationCheckRuntimeModule["evaluateBundledPluginPublicSurfaceAccess"];
    throwForBundledPluginPublicSurfaceAccess: FacadeActivationCheckRuntimeModule["throwForBundledPluginPublicSurfaceAccess"];
    resolveActivatedBundledPluginPublicSurfaceAccessOrThrow: (params: BundledPluginPublicSurfaceParams) => {
        allowed: boolean;
        pluginId?: string;
        reason?: string;
    };
    resolveBundledPluginPublicSurfaceAccess: (params: BundledPluginPublicSurfaceParams) => {
        allowed: boolean;
        pluginId?: string;
        reason?: string;
    };
    resolveTrackedFacadePluginId: (params: BundledPluginPublicSurfaceParams) => string;
};
