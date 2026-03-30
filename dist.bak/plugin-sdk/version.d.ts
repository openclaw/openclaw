export declare function readVersionFromPackageJsonForModuleUrl(moduleUrl: string): string | null;
export declare function readVersionFromBuildInfoForModuleUrl(moduleUrl: string): string | null;
export declare function resolveVersionFromModuleUrl(moduleUrl: string): string | null;
export type RuntimeVersionEnv = {
    [key: string]: string | undefined;
};
export declare function resolveRuntimeServiceVersion(env?: RuntimeVersionEnv, fallback?: string): string;
export declare const VERSION: string;
