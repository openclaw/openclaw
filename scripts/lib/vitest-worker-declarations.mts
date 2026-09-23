// Declaration paths are shared metadata; only the runner imports their build values.
export const nativeSchtasksIntegrationEnabled =
  process.platform === "win32" && process.env.CI_WINDOWS_SCHTASKS_INTEGRATION === "1";

// The CLI loads this package-root supervisor by URL instead of bundling it.
export const vitestWorkerRuntimeAssets = ["node-host-launcher.mjs"];

export const runtimeProcessDeclarationEntries = {
  "extensions/memory-core/manager-cpu-entrypoints":
    "extensions/memory-core/src/memory/manager-cpu-entrypoints.ts",
  "infra/runtime-process-entrypoints": "src/infra/runtime-process-entrypoints.ts",
  "extensions/document-extract/document-extractor-worker-entrypoint":
    "extensions/document-extract/document-extractor-worker-entrypoint.ts",
  "extensions/memory-core/manager-search-knn-entrypoint":
    "extensions/memory-core/src/memory/manager-search-knn-entrypoint.ts",
};
export const vitestWorkerDeclarationEntries = {
  ...runtimeProcessDeclarationEntries,
  "test-support/bench-session-history-runtime":
    "scripts/bench-session-history-runtime.test-support.ts",
  "extensions/discord/src/voice/audio-worker-entrypoints.test-support":
    "extensions/discord/src/voice/audio-worker-entrypoints.test-support.ts",
  // Codex is package-owned and excluded from the root runtime bundle.
  "extensions/codex/catalog-page-worker-entrypoint":
    "extensions/codex/catalog-page-worker-entrypoint.ts",
  "extensions/memory-core/manager-publication-fault-entrypoint.test-support":
    "extensions/memory-core/src/memory/manager-publication-fault-entrypoint.test-support.ts",
  "state/openclaw-agent-worker-store.runtime.test-support":
    "src/state/openclaw-agent-worker-store.runtime.test-support.ts",
  "cli/update-cli/update-command-legacy-finalize-entrypoint.test-support":
    "src/cli/update-cli/update-command-legacy-finalize-entrypoint.test-support.ts",
  "cli/update-cli/update-command-migrated-fixture-entrypoint.test-support":
    "src/cli/update-cli/update-command-migrated-fixture-entrypoint.test-support.ts",
  "extensions/logbook/sqlite-backend-entrypoint.test-support":
    "extensions/logbook/src/sqlite-backend-entrypoint.test-support.ts",
  "extensions/team-reports/sqlite-backend-entrypoint.test-support":
    "extensions/team-reports/src/sqlite-backend-entrypoint.test-support.ts",
  "extensions/workboard/sqlite-backend-entrypoint.test-support":
    "extensions/workboard/src/sqlite-backend-entrypoint.test-support.ts",
  "infra/update-managed-service-handoff-runtime-assets":
    "src/infra/update-managed-service-handoff-runtime-assets.ts",
  "infra/triage-runtime.test-support": "src/infra/triage-runtime.test-support.ts",
  "infra/sqlite-readonly-worker.compile-cache-runtime.test-support":
    "src/infra/sqlite-readonly-worker.compile-cache-runtime.test-support.ts",
  "cli/cli-entrypoint.test-support": "src/cli/cli-entrypoint.test-support.ts",
  ...(nativeSchtasksIntegrationEnabled
    ? {
        "daemon/schtasks-native-entrypoints.test-support":
          "src/daemon/schtasks-native-entrypoints.test-support.ts",
      }
    : {}),
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
  "plugins/runtime-retention-entrypoint.test-support":
    "src/plugins/runtime-retention-entrypoint.test-support.ts",
  "system-agent/setup-inference-groq-sdk.test-support":
    "src/system-agent/setup-inference-groq-sdk.test-support.ts",
  "agents/auth-profiles/store-scope-cwd-runtime.test-support":
    "src/agents/auth-profiles/store-scope-cwd-runtime.test-support.ts",
  "agents/bash-tools.process-liveness-runtime.test-support":
    "src/agents/bash-tools.process-liveness-runtime.test-support.ts",
  "agents/code-mode-retention-entrypoint.test-support":
    "src/agents/code-mode-retention-entrypoint.test-support.ts",
  "agents/command/cli-compaction-runtime.test-support":
    "src/agents/command/cli-compaction-runtime.test-support.ts",
  "agents/sessions/bash-output-spill-entrypoints.test-support":
    "src/agents/sessions/bash-output-spill-entrypoints.test-support.ts",
  "cron/owner-hardening-runtime.test-support": "src/cron/owner-hardening-runtime.test-support.ts",
  "gateway/session-child-cache-retention-entrypoint.test-support":
    "src/gateway/session-child-cache-retention-entrypoint.test-support.ts",
  "gateway/session-title-retention.test-support":
    "src/gateway/session-title-retention.test-support.ts",
  "node-host/config-runtime.test-support": "src/node-host/config-runtime.test-support.ts",
  "worker/worker-runtime-background-exec-entrypoints.test-support":
    "src/worker/worker-runtime-background-exec-entrypoints.test-support.ts",
  "skills/library/persistence-runtime.test-support":
    "src/skills/library/persistence-runtime.test-support.ts",
  "snapshot/git-backup-command-runtime.test-support":
    "src/snapshot/git-backup-command-runtime.test-support.ts",
  "state/openclaw-database-verify-runtime.test-support":
    "src/state/openclaw-database-verify-runtime.test-support.ts",
  "state/openclaw-state-lease-runtime.test-support":
    "src/state/openclaw-state-lease-runtime.test-support.ts",
  "transcripts/library-timezone-runtime.test-support":
    "src/transcripts/library-timezone-runtime.test-support.ts",
  "state/openclaw-agent-db-module-identity-runtime.test-support":
    "src/state/openclaw-agent-db-module-identity-runtime.test-support.ts",
  "tui/tui-pty-runtime-test-support": "src/tui/tui-pty-runtime-test-support.ts",
};
