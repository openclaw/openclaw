export const memoryCpuProcessEntrypoints = {
  search: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "manager-search.worker",
    distWorkerPath: "extensions/memory-core/memory-search.worker.js",
  },
  index: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "manager-index.worker",
    distWorkerPath: "extensions/memory-core/memory-index.worker.js",
  },
} as const;
