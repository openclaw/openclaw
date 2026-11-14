// Prepare native process probes before their liveness, readiness, and retention deadlines.
export const agentProcessTestEntrypoints = {
  durableProcesses: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "bash-process-durable.test-support",
    distWorkerPath: "agents/bash-process-durable.test-support.js",
  },
  durableProcessStore: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "bash-durable-process-store.test-support",
    distWorkerPath: "agents/bash-durable-process-store.test-support.js",
  },
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
  lifecycleCreationRetention: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "lifecycle-creation.retention.test-support",
    distWorkerPath: "agents/lifecycle-creation.retention.test-support.js",
  },
  toolAuthorityRetention: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "harness/tool-authority.runtime.retention.test-support",
    distWorkerPath: "agents/harness/tool-authority.runtime.retention.test-support.js",
  },
  modelGenerationRetention: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "prepared-model-runtime-generation.retention.test-support",
    distWorkerPath: "agents/prepared-model-runtime-generation.retention.test-support.js",
  },
  readRetention: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "sessions/tools/read.retention.test-support",
    distWorkerPath: "agents/sessions/tools/read.retention.test-support.js",
  },
  sessionManager: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "sessions/session-manager",
    distWorkerPath: "agents/sessions/session-manager.js",
  },
  transcriptWrite: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../config/sessions/session-accessor.sqlite-transcript-write.test-support",
    distWorkerPath: "config/sessions/session-accessor.sqlite-transcript-write.test-support.js",
  },
  transcriptLifecycleRetention: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName:
      "embedded-agent-runner/run/attempt-transcript-lifecycle.retention.test-support",
    distWorkerPath:
      "agents/embedded-agent-runner/run/attempt-transcript-lifecycle.retention.test-support.js",
  },
} as const;
