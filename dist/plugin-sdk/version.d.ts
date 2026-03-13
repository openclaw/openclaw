export declare function readVersionFromPackageJsonForModuleUrl(moduleUrl: string): string | null;
export declare function readVersionFromBuildInfoForModuleUrl(moduleUrl: string): string | null;
export declare function resolveVersionFromModuleUrl(moduleUrl: string): string | null;
export declare function resolveBinaryVersion(params: {
    moduleUrl: string;
    injectedVersion?: string;
    bundledVersion?: string;
    fallback?: string;
}): string;
export type RuntimeVersionEnv = {
    [key: string]: string | undefined;
};
export declare const RUNTIME_SERVICE_VERSION_FALLBACK = "unknown";
export declare function resolveUsableRuntimeVersion(version: string | undefined): string | undefined;
export declare function resolveRuntimeServiceVersion(env?: RuntimeVersionEnv, fallback?: string): string;
export declare const VERSION: string;
