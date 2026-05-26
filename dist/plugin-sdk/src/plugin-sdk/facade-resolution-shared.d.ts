export type FacadeModuleLocationLike = {
    modulePath: string;
    boundaryRoot: string;
};
type FacadeRegistryRecordLike = {
    id: string;
    rootDir: string;
    channels: readonly string[];
};
export declare function createFacadeResolutionKey(params: {
    dirName: string;
    artifactBasename: string;
    bundledPluginsDir?: string | null;
    env?: NodeJS.ProcessEnv;
}): string;
export declare function resolveFacadeBoundaryRoot(params: {
    modulePath: string;
    bundledPluginsDir?: string | null;
    packageRoot: string;
}): string;
export declare function resolveBundledFacadeModuleLocation(params: {
    currentModulePath: string;
    packageRoot: string;
    dirName: string;
    artifactBasename: string;
    env?: NodeJS.ProcessEnv;
    bundledPluginsDir?: string | null;
}): FacadeModuleLocationLike | null;
export declare function resolveRegistryPluginModuleLocationFromRecords(params: {
    registry: readonly FacadeRegistryRecordLike[];
    dirName: string;
    artifactBasename: string;
}): FacadeModuleLocationLike | null;
export {};
