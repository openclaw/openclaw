// Prepare native process probes before their liveness, readiness, and retention deadlines.
export const agentProcessTestEntrypoints = {
  blockChunker: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "embedded-agent-block-chunker",
    distWorkerPath: "agents/embedded-agent-block-chunker.js",
  },
  markdownIr: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../packages/markdown-core/src/ir",
    distWorkerPath: "packages/markdown-core/ir.js",
  },
  callback: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "embedded-agent-subscribe.callback",
    distWorkerPath: "agents/embedded-agent-subscribe.callback.js",
  },
  unhandledRejections: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/unhandled-rejections",
    distWorkerPath: "infra/unhandled-rejections.js",
  },
  providerLocalService: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "provider-local-service",
    distWorkerPath: "agents/provider-local-service.js",
  },
  settingsStorage: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "sessions/settings-storage",
    distWorkerPath: "agents/sessions/settings-storage.js",
  },
  readRetention: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "sessions/tools/read.retention.test-support",
    distWorkerPath: "agents/sessions/tools/read.retention.test-support.js",
  },
  outputAccumulator: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "sessions/tools/output-accumulator",
    distWorkerPath: "agents/sessions/tools/output-accumulator.js",
  },
  transcriptLifecycleRetention: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName:
      "embedded-agent-runner/run/attempt-transcript-lifecycle.retention.test-support",
    distWorkerPath:
      "agents/embedded-agent-runner/run/attempt-transcript-lifecycle.retention.test-support.js",
  },
} as const;
