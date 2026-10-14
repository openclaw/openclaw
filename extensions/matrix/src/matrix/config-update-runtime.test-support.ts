export const matrixConfigImportEntrypoints = {
  update: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "config-update",
    distWorkerPath: "legacy-finalizer/extensions/matrix/src/matrix/config-update.js",
  },
  account: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "account-config",
    distWorkerPath: "legacy-finalizer/extensions/matrix/src/matrix/account-config.js",
  },
} as const;
