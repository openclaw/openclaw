//#region src/version.d.ts
declare function readVersionFromPackageJsonForModuleUrl(moduleUrl: string): string | null;
declare function readVersionFromBuildInfoForModuleUrl(moduleUrl: string): string | null;
declare function resolveVersionFromModuleUrl(moduleUrl: string): string | null;
declare function resolveBinaryVersion(params: {
  moduleUrl: string;
  injectedVersion?: string;
  bundledVersion?: string;
  fallback?: string;
}): string;
type RuntimeVersionEnv = {
  [key: string]: string | undefined;
};
declare const RUNTIME_SERVICE_VERSION_FALLBACK = "unknown";
declare function resolveUsableRuntimeVersion(version: string | undefined): string | undefined;
declare function resolveRuntimeServiceVersion(env?: RuntimeVersionEnv, fallback?: string): string;
declare function resolveCompatibilityHostVersion(env?: RuntimeVersionEnv, fallback?: string): string;
declare const VERSION: string;
//#endregion
export { readVersionFromPackageJsonForModuleUrl as a, resolveRuntimeServiceVersion as c, readVersionFromBuildInfoForModuleUrl as i, resolveUsableRuntimeVersion as l, RuntimeVersionEnv as n, resolveBinaryVersion as o, VERSION as r, resolveCompatibilityHostVersion as s, RUNTIME_SERVICE_VERSION_FALLBACK as t, resolveVersionFromModuleUrl as u };