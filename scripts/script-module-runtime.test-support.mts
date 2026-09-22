// MTS declarations preserve the source extension before runner preparation.
export const scriptModuleEntrypoints = {
  vitestBatchRunner: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "lib/vitest-batch-runner",
    sourceExtension: ".mts",
    distWorkerPath: "legacy-finalizer/scripts/lib/vitest-batch-runner.js",
  },
  additionalBoundaryChecks: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "run-additional-boundary-checks",
    sourceExtension: ".mts",
    distWorkerPath: "legacy-finalizer/scripts/run-additional-boundary-checks.js",
  },
  runWithEnv: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "run-with-env",
    sourceExtension: ".mts",
    distWorkerPath: "legacy-finalizer/scripts/run-with-env.js",
  },
  pluginSdkApiDiff: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "plugin-sdk-api-diff",
    sourceExtension: ".mts",
    distWorkerPath: "legacy-finalizer/scripts/plugin-sdk-api-diff.js",
  },
  testProjects: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "test-projects",
    sourceExtension: ".mts",
    distWorkerPath: "legacy-finalizer/scripts/test-projects.js",
  },
  vitestBuildPrerequisites: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "lib/vitest-build-prerequisites",
    sourceExtension: ".mts",
    distWorkerPath: "legacy-finalizer/scripts/lib/vitest-build-prerequisites.js",
  },
  checkMemoryFdRepro: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "check-memory-fd-repro",
    sourceExtension: ".mts",
    distWorkerPath: "legacy-finalizer/scripts/check-memory-fd-repro.js",
  },
} as const;
