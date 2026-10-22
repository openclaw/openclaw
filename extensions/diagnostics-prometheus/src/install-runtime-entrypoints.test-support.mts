export const packagingEntrypoints = {
  runtimeBuild: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../../scripts/lib/plugin-npm-runtime-build",
    distWorkerPath: "legacy-finalizer/scripts/lib/plugin-npm-runtime-build.js",
  },
  packageManifest: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../../scripts/lib/plugin-npm-package-manifest",
    distWorkerPath: "legacy-finalizer/scripts/lib/plugin-npm-package-manifest.js",
  },
} as const;
