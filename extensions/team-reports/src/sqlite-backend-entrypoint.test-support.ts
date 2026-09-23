// Fresh database workers share compiled backend code, never database state.
export const teamReportsSqliteBackendEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "store.worker",
  distWorkerPath: "extensions/team-reports/src/store.worker.js",
} as const;
