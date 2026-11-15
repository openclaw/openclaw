// Prepare standalone script graphs before native process guards begin.
export const scriptProcessEntrypoints = {
  packageDistInventory: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "write-package-dist-inventory",
    distWorkerPath: "legacy-finalizer/scripts/write-package-dist-inventory.js",
  },
  agentPluginGatewayE2e: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "agent-plugin-gateway-e2e",
    distWorkerPath: "legacy-finalizer/scripts/agent-plugin-gateway-e2e.js",
  },
  npmUpdateSmoke: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "e2e/parallels/npm-update-smoke",
    distWorkerPath: "legacy-finalizer/scripts/e2e/parallels/npm-update-smoke.js",
  },
  parallelsHostCommand: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "e2e/parallels/host-command",
    distWorkerPath: "legacy-finalizer/scripts/e2e/parallels/host-command.js",
  },
  macosSmoke: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "e2e/parallels/macos-smoke",
    distWorkerPath: "legacy-finalizer/scripts/e2e/parallels/macos-smoke.js",
  },
  updateJobTimeout: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "e2e/parallels/update-job-timeout",
    distWorkerPath: "legacy-finalizer/scripts/e2e/parallels/update-job-timeout.js",
  },
  anthropicPromptProbe: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "anthropic-prompt-probe",
    distWorkerPath: "legacy-finalizer/scripts/anthropic-prompt-probe.js",
  },
  releaseVerifyBeta: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "release-verify-beta",
    distWorkerPath: "legacy-finalizer/scripts/release-verify-beta.js",
  },
  releaseVerifyPublish: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "release-verify-publish",
    distWorkerPath: "legacy-finalizer/scripts/release-verify-publish.js",
  },
  cliStartupMetadata: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "write-cli-startup-metadata",
    distWorkerPath: "legacy-finalizer/scripts/write-cli-startup-metadata.js",
  },
} as const;
