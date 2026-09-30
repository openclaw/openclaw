export const memoryCpuProcessEntrypoints = {
  search: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "manager-search.worker",
    distWorkerPath: "extensions/memory-core/memory-search.worker.js",
    package: {
      name: "@openclaw/memory-core",
      distWorkerPath: "src/memory/manager-search.worker.js",
    },
  },
  index: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "manager-index.worker",
    distWorkerPath: "extensions/memory-core/memory-index.worker.js",
    package: {
      name: "@openclaw/memory-core",
      distWorkerPath: "src/memory/manager-index.worker.js",
    },
  },
  publication: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "manager-publication.worker",
    distWorkerPath: "extensions/memory-core/memory-publication.worker.js",
    package: {
      name: "@openclaw/memory-core",
      distWorkerPath: "src/memory/manager-publication.worker.js",
    },
  },
  standingIntents: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../standing-intents.worker",
    distWorkerPath: "extensions/memory-core/standing-intents.worker.js",
    package: {
      name: "@openclaw/memory-core",
      distWorkerPath: "src/standing-intents.worker.js",
    },
  },
  entryOrigins: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../memory-entry-origins.worker",
    distWorkerPath: "extensions/memory-core/memory-entry-origins.worker.js",
    package: {
      name: "@openclaw/memory-core",
      distWorkerPath: "src/memory-entry-origins.worker.js",
    },
  },
} as const;
