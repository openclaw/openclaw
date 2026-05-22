//#region src/plugins/public-surface-runtime.d.ts
declare const PUBLIC_SURFACE_SOURCE_EXTENSIONS: readonly [".ts", ".mts", ".js", ".mjs", ".cts", ".cjs"];
declare function normalizeBundledPluginArtifactSubpath(artifactBasename: string): string;
declare function normalizeBundledPluginDirName(dirName: string): string;
declare function resolveBundledPluginSourcePublicSurfacePath(params: {
  sourceRoot: string;
  dirName: string;
  artifactBasename: string;
}): string | null;
declare function resolveBundledPluginPublicSurfacePath(params: {
  rootDir: string;
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
  bundledPluginsDir?: string;
}): string | null;
//#endregion
export { PUBLIC_SURFACE_SOURCE_EXTENSIONS, normalizeBundledPluginArtifactSubpath, normalizeBundledPluginDirName, resolveBundledPluginPublicSurfacePath, resolveBundledPluginSourcePublicSurfacePath };