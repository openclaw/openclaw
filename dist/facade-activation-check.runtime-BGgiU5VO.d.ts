import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { t as PluginManifestRecord } from "./manifest-registry-CMekBFSM.js";
import { n as createPluginActivationSource, r as normalizePluginsConfig } from "./config-state-BGq9BY_v.js";

//#region src/plugin-sdk/facade-activation-check.runtime.d.ts
type FacadePluginManifestLike = Pick<PluginManifestRecord, "id" | "origin" | "enabledByDefault" | "enabledByDefaultOnPlatforms" | "rootDir" | "channels">;
type FacadeModuleLocation = {
  modulePath: string;
  boundaryRoot: string;
};
declare function resolveRegistryPluginModuleLocation(params: {
  dirName: string;
  artifactBasename: string;
  resolutionKey: string;
  env?: NodeJS.ProcessEnv;
}): FacadeModuleLocation | null;
declare function resolveTrackedFacadePluginId(params: {
  dirName: string;
  artifactBasename: string;
  location: FacadeModuleLocation | null;
  sourceExtensionsRoot: string;
  resolutionKey: string;
  env?: NodeJS.ProcessEnv;
}): string;
declare function resolveBundledPluginPublicSurfaceAccess(params: {
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
declare function evaluateBundledPluginPublicSurfaceAccess(params: {
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
declare function throwForBundledPluginPublicSurfaceAccess(params: {
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
declare function resolveActivatedBundledPluginPublicSurfaceAccessOrThrow(params: {
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
//#endregion
export { resolveRegistryPluginModuleLocation as a, resolveBundledPluginPublicSurfaceAccess as i, evaluateBundledPluginPublicSurfaceAccess as n, resolveTrackedFacadePluginId as o, resolveActivatedBundledPluginPublicSurfaceAccessOrThrow as r, throwForBundledPluginPublicSurfaceAccess as s, FacadePluginManifestLike as t };