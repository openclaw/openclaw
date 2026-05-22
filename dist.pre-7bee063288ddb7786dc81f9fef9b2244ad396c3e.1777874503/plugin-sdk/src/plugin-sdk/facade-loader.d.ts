import { type PluginModuleLoaderFactory } from "../plugins/plugin-module-loader-cache.js";
export declare function createLazyFacadeObjectValue<T extends object>(load: () => T): T;
export declare function createLazyFacadeArrayValue<T extends readonly unknown[]>(load: () => T): T;
export type FacadeModuleLocation = {
    modulePath: string;
    boundaryRoot: string;
};
export declare function loadFacadeModuleAtLocationSync<T extends object>(params: {
    location: FacadeModuleLocation;
    trackedPluginId: string | (() => string);
    loadModule?: (modulePath: string) => T;
}): T;
export declare function loadBundledPluginPublicSurfaceModuleSync<T extends object>(params: {
    dirName: string;
    artifactBasename: string;
    trackedPluginId?: string | (() => string);
    env?: NodeJS.ProcessEnv;
}): T;
export declare function loadBundledPluginPublicSurfaceModule<T extends object>(params: {
    dirName: string;
    artifactBasename: string;
    trackedPluginId?: string | (() => string);
}): Promise<T>;
export declare function listImportedBundledPluginFacadeIds(): string[];
export declare function resetFacadeLoaderStateForTest(): void;
export declare function setFacadeLoaderSourceTransformFactoryForTest(factory: PluginModuleLoaderFactory | undefined): void;
