export const agentCoreRetentionEntrypoints = {
  context: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "agent-loop.retention.test-support",
    distWorkerPath: "packages/agent-core/agent-loop.retention.test-support.js",
  },
  truncate: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "harness/utils/truncate.retention.test-support",
    distWorkerPath: "packages/agent-core/harness/utils/truncate.retention.test-support.js",
  },
} as const;
