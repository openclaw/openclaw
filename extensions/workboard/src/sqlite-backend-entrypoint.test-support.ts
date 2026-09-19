// Fresh database workers share compiled backend code, never database state.
export const workboardSqliteBackendEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "sqlite-store.worker",
  distWorkerPath: "extensions/workboard/src/sqlite-store.worker.js",
} as const;
