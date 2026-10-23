export const memoryStatsRuntimeEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "lancedb-runtime",
  package: {
    name: "@openclaw/memory-lancedb",
    distWorkerPath: "lancedb-runtime.js",
  },
  distWorkerPath: "extensions/memory-lancedb/lancedb-runtime.js",
} as const;
