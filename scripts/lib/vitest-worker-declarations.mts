// Declaration paths are shared metadata; only the runner imports their build values.
export const runtimeProcessDeclarationEntries = {
  "infra/runtime-process-entrypoints": "src/infra/runtime-process-entrypoints.ts",
  "extensions/memory-core/manager-search-knn-entrypoint":
    "extensions/memory-core/src/memory/manager-search-knn-entrypoint.ts",
};
export const vitestWorkerDeclarationEntries = {
  ...runtimeProcessDeclarationEntries,
  "infra/update-managed-service-handoff-runtime-assets":
    "src/infra/update-managed-service-handoff-runtime-assets.ts",
  "infra/triage-runtime.test-support": "src/infra/triage-runtime.test-support.ts",
  "cli/cli-entrypoint.test-support": "src/cli/cli-entrypoint.test-support.ts",
  "cli/update-cli/update-command-executor-native-runtime.test-support":
    "src/cli/update-cli/update-command-executor-native-runtime.test-support.ts",
  "commands/doctor-config-runtime.test-support":
    "src/commands/doctor-config-runtime.test-support.ts",
  "test-support/channel-ingress-gateway-restart-entrypoint":
    "test/fixtures/channel-ingress-gateway-restart-entrypoint.ts",
  "extensions/qa-lab/gateway-child-artifacts-runtime.test-support":
    "extensions/qa-lab/src/gateway-child-artifacts-runtime.test-support.ts",
  "plugins/loader-sdk-bridge-artifacts.test-support":
    "src/plugins/loader-sdk-bridge-artifacts.test-support.ts",
  "agents/code-mode-retention-entrypoint.test-support":
    "src/agents/code-mode-retention-entrypoint.test-support.ts",
  "agents/command/cli-compaction-runtime.test-support":
    "src/agents/command/cli-compaction-runtime.test-support.ts",
  "cron/owner-hardening-runtime.test-support": "src/cron/owner-hardening-runtime.test-support.ts",
  "gateway/server-methods/sessions-list-cache-retention-entrypoint.test-support":
    "src/gateway/server-methods/sessions-list-cache-retention-entrypoint.test-support.ts",
  "gateway/session-child-cache-retention-entrypoint.test-support":
    "src/gateway/session-child-cache-retention-entrypoint.test-support.ts",
  "gateway/session-title-retention.test-support":
    "src/gateway/session-title-retention.test-support.ts",
  "node-host/config-runtime.test-support": "src/node-host/config-runtime.test-support.ts",
  "skills/library/persistence-runtime.test-support":
    "src/skills/library/persistence-runtime.test-support.ts",
  "state/openclaw-state-lease-runtime.test-support":
    "src/state/openclaw-state-lease-runtime.test-support.ts",
  "tui/tui-pty-runtime-test-support": "src/tui/tui-pty-runtime-test-support.ts",
};
