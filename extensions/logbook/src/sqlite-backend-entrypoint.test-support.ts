// Fresh database workers share compiled backend code, never database state.
export const logbookSqliteBackendEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "store.worker",
  distWorkerPath: "extensions/logbook/src/store.worker.js",
} as const;
