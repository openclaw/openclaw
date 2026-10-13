export const codexHistoryWorkerEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "session-history.worker",
  distWorkerPath: "extensions/codex/session-history.worker.js",
  package: {
    name: "@openclaw/codex",
    distWorkerPath: "session-history.worker.js",
  },
} as const;
