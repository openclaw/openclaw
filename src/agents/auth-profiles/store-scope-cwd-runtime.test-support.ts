export const authProfileScopeCwdEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "store-scope-cwd.test-support",
  distWorkerPath: "agents/auth-profiles/store-scope-cwd.test-support.js",
} as const;

export const authProfileAsyncSaveEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "store-async-save.test-support",
  distWorkerPath: "agents/auth-profiles/store-async-save.test-support.js",
} as const;
