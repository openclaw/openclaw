// Prepare the real benchmark and its self-spawned readers before the child deadline starts.
export const benchSessionHistoryEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "bench-session-history",
  distWorkerPath: "test-support/bench-session-history.js",
} as const;
