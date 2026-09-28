import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { isPlainRepoRelativePath } from "../../test/vitest/vitest.include-patterns.ts";

type PolicyTestWatch = {
  ownerGlobs?: readonly string[];
  testFile: string;
  watchGlobs: readonly string[];
};

// These tests read source trees instead of importing every file whose policy
// they enforce. Boundary and contract suites have dedicated always-on lanes;
// this inventory covers the remaining tests that changed targeting cannot
// discover from imports alone.
const policyTestWatches = [
  // These owner contracts enter production through fixture adapters or a facade.
  {
    testFile: "src/agents/agent-bundle-mcp-reload.test.ts",
    watchGlobs: ["src/agents/agent-bundle-mcp-manager.ts"],
  },
  {
    testFile: "src/auto-reply/status.test.ts",
    watchGlobs: ["src/status/status-message.ts"],
  },
  {
    testFile: "src/cron/isolated-agent.session-identity.test.ts",
    watchGlobs: ["src/cron/isolated-agent/run.ts"],
  },
  {
    testFile: "extensions/discord/src/monitor/message-handler.process.ack.test.ts",
    watchGlobs: ["extensions/discord/src/monitor/message-handler.process.ts"],
  },
  {
    testFile: "extensions/codex/src/app-server/run-attempt.turn-watches.test.ts",
    watchGlobs: ["extensions/codex/src/app-server/run-attempt.ts"],
  },
  {
    testFile: "extensions/telegram/src/bot-message-dispatch.preview.telegram-http.test.ts",
    watchGlobs: ["extensions/telegram/src/bot-message-dispatch.ts"],
  },
  {
    testFile: "src/gateway/session-utils.search.test.ts",
    watchGlobs: ["src/agents/identity-file.worker.ts"],
  },
  ...[
    "src/gateway/worker-environments/placement-dispatch-recovery.test.ts",
    "src/gateway/worker-environments/worker-turn-launcher-media.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/gateway/worker-environments/placement-dispatch-store.worker.ts",
      "src/gateway/worker-environments/placement-turn-claims.worker.ts",
    ],
  })),
  ...[
    "src/gateway/worker-environments/placement-dispatch-recovery.test.ts",
    "src/gateway/worker-environments/worker-turn-launcher-media.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/gateway/worker-environments/store.kernel.ts",
      "src/gateway/worker-environments/store.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  })),
  {
    testFile: "test/scripts/crabbox-wrapper.test.ts",
    watchGlobs: [
      "scripts/crabbox-source-capsule.mts",
      "scripts/crabbox-source-receiver.mts",
      "scripts/crabbox-staging-artifacts.mts",
      "scripts/crabbox-staging-claims.mts",
      "scripts/crabbox-staging.mts",
    ],
  },
  ...[
    "src/commands/agents.roles.test.ts",
    "src/commands/onboard-non-interactive/local.default-agent.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: ["docs/reference/templates/roles/**"],
  })),
  {
    testFile: "src/gateway/server-methods/send.scheduled-reads.integration.test.ts",
    watchGlobs: ["extensions/discord/src/**/*.ts"],
  },
  {
    testFile: "src/system-agent/setup-inference.groq-external.integration.test.ts",
    watchGlobs: ["extensions/groq/**"],
  },
  ...[
    "src/agents/embedded-agent-runner/model.test.ts",
    "src/gateway/talk/handlers/client-native-control.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: ["extensions/openai/**"],
  })),
  ...[
    "extensions/qa-lab/src/ci-smoke-plan.test.ts",
    "extensions/qa-lab/src/cli.runtime.test.ts",
    "extensions/qa-lab/src/live-transports/slack/slack-live.runtime.test.ts",
    "extensions/qa-lab/src/profile-evidence-plan.test.ts",
    "extensions/qa-lab/src/scenario-retained-final.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: ["qa/scenarios/**"],
  })),
  // Filename-launched workers and native subprocess owners are not static imports.
  ...[
    "extensions/browser/chrome-extension/background.creation-lifecycle.test.ts",
    "extensions/browser/chrome-extension/background.initial-target.test.ts",
    "extensions/browser/chrome-extension/background.relay-lifecycle.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "extensions/browser/chrome-extension/background.js",
      "extensions/browser/chrome-extension/modules/native-bootstrap.js",
      "extensions/browser/chrome-extension/modules/popup-background.js",
      "extensions/browser/chrome-extension/modules/relay-auth-v2.js",
      "extensions/browser/chrome-extension/modules/relay-command-handler.js",
      "extensions/browser/chrome-extension/modules/relay-connection.js",
      "extensions/browser/chrome-extension/modules/relay-core.js",
      "extensions/browser/chrome-extension/modules/relay-debugger.js",
      "extensions/browser/chrome-extension/modules/relay-tab-groups.js",
      "extensions/browser/chrome-extension/modules/tab-access-command-scope.js",
      "extensions/browser/chrome-extension/modules/tab-access-events.js",
      "extensions/browser/chrome-extension/modules/tab-access.js",
      "extensions/browser/chrome-extension/modules/tab-document-provenance.js",
      "extensions/browser/chrome-extension/modules/tab-eligibility.js",
      "extensions/browser/chrome-extension/modules/tab-group-revocations.js",
    ],
  })),
  {
    testFile: "extensions/codex/src/session-catalog-native-performance.test.ts",
    watchGlobs: ["pnpm-lock.yaml"],
  },
  ...[
    "extensions/copilot/src/attempt-transcript-journal.test.ts",
    "extensions/memory-core/src/memory/manager-sync-ops.startup-catchup.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/config/sessions/session-transcript-reconcile.worker.ts",
      "src/config/sessions/session-transcript.worker.ts",
    ],
  })),
  ...[
    "extensions/diffs/src/store.test.ts",
    "extensions/diffs/src/tool.test.ts",
    "extensions/memory-wiki/src/compiled-cache.integration.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/plugin-state/plugin-blob-store.worker.ts",
      "src/state/openclaw-state-read.worker.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  })),
  {
    testFile: "extensions/file-transfer/src/workspace-service.test.ts",
    watchGlobs: ["src/worker/memory-worker-entry.ts", "src/worker/skills-worker-entry.ts"],
  },
  {
    testFile: "extensions/logbook/src/service-lifecycle.test.ts",
    watchGlobs: ["extensions/logbook/src/store.worker.ts"],
  },
  ...[
    "extensions/memory-core/src/cli.test.ts",
    "extensions/memory-core/src/memory/manager-captured-session-preparation.test.ts",
    "extensions/memory-core/src/memory/manager-memory-source-race.test.ts",
    "extensions/memory-core/src/memory/manager-provider-lifecycle-fallback.test.ts",
    "extensions/memory-core/src/memory/manager-provider-lifecycle-leases.test.ts",
    "extensions/memory-core/src/memory/manager-reads.test.ts",
    "extensions/memory-core/src/memory/manager-search-worker.test.ts",
    "extensions/memory-core/src/memory/manager-startup-close.test.ts",
    "extensions/memory-core/src/memory/watch-capacity.test.ts",
    "extensions/memory-core/src/tools.real-manager.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "extensions/memory-core/src/memory/manager-index.worker.ts",
      "extensions/memory-core/src/memory/manager-publication.worker.ts",
      "extensions/memory-core/src/memory/manager-search.worker.ts",
    ],
  })),
  ...[
    "extensions/qa-lab/src/ci-smoke-plan.test.ts",
    "extensions/qa-lab/src/cli.runtime.test.ts",
    "extensions/qa-lab/src/profile-evidence-plan.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: ["taxonomy.yaml"],
  })),
  {
    testFile: "extensions/team-reports/src/store.test.ts",
    watchGlobs: ["extensions/team-reports/src/store.worker.ts"],
  },
  ...[
    "extensions/workboard/src/dispatcher-ownership.test.ts",
    "extensions/workboard/src/dispatcher.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: ["extensions/workboard/src/sqlite-store.worker.ts"],
  })),
  {
    testFile: "packages/memory-host-sdk/src/host/session-memory-sync.test.ts",
    watchGlobs: [
      "src/config/sessions/session-accessor.sqlite-archive.worker.ts",
      "src/config/sessions/session-transcript-reconcile.worker.ts",
    ],
  },
  ...[
    "src/acp/runtime/session-meta.alias-lifecycle.test.ts",
    "src/commands/doctor-config-health-freshness.test.ts",
    "src/commands/doctor/shared/post-core-plugin-convergence.persistence.test.ts",
    "src/hooks/installs.test.ts",
    "src/infra/sqlite-worker-terminal-admission.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  })),
  {
    testFile: "src/agents/agent-harness-completion-delivery.test.ts",
    watchGlobs: [
      "src/config/sessions/session-transcript.worker.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  },
  {
    testFile: "src/agents/auth-profiles/store-owner-publication.test.ts",
    watchGlobs: [
      "src/agents/auth-profiles/store-scope-cwd.test-support.ts",
      "src/state/openclaw-state-worker-runtime.ts",
    ],
  },
  ...[
    "src/agents/embedded-agent-runner/run/attempt-prompt-submit.test.ts",
    "src/agents/embedded-agent-runner/run/attempt-stream-custody.test.ts",
    "src/agents/embedded-agent-runner/run/attempt-transcript-lifecycle-prepare.test.ts",
    "src/agents/embedded-agent-runner/run/attempt.spawn-workspace.context-engine.test.ts",
    "src/agents/embedded-agent-runner/transcript-rewrite.test.ts",
    "src/agents/subagents/spawn/subagent-spawn.preparation-authority.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/config/sessions/session-transcript-projection-publication.worker.ts",
      "src/config/sessions/session-transcript-reconcile.worker.ts",
      "src/config/sessions/session-transcript.worker.ts",
    ],
  })),
  ...[
    "src/agents/mcp-config-mutation.test.ts",
    "src/agents/mcp-oauth-refresh-issuer.test.ts",
    "src/agents/mcp-oauth.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/agents/mcp-oauth-store.worker.ts",
      "src/state/openclaw-state-read.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
    ],
  })),
  {
    testFile: "src/agents/model-auth.profiles.test.ts",
    watchGlobs: ["src/state/openclaw-state-worker-runtime.ts"],
  },
  {
    testFile: "src/agents/sandbox/registry-read.test.ts",
    watchGlobs: [
      "src/agents/sandbox/registry-write.worker.ts",
      "src/state/openclaw-state-read-registry.ts",
      "src/state/openclaw-state-read.worker.ts",
    ],
  },
  ...[
    "src/agents/sessions/agent-session-models.admission.test.ts",
    "src/agents/sessions/sdk.auth-migration.test.ts",
    "src/agents/sessions/sdk.test.ts",
    "src/agents/sessions/session-manager-target-capture.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/agents/sessions/session-manager-metadata.worker.ts",
      "src/config/sessions/session-transcript.worker.ts",
      "src/infra/sqlite-store.worker.ts",
    ],
  })),
  ...[
    "src/agents/sessions/session-manager-bounded.test.ts",
    "src/agents/sessions/session-manager-model-context.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/agents/sessions/session-manager-metadata.worker.ts",
      "src/config/sessions/session-transcript-reconcile.worker.ts",
      "src/config/sessions/session-transcript.worker.ts",
      "src/infra/sqlite-store.worker.ts",
    ],
  })),
  ...[
    "src/agents/shell-snapshot.broker.test.ts",
    "src/process/spawn-broker/cleanup.test.ts",
    "src/process/spawn-broker/restart.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: ["src/process/spawn-broker/worker.ts"],
  })),
  {
    testFile: "src/agents/subagents/registry/subagent-control.publication.test.ts",
    watchGlobs: [
      "src/config/sessions/session-cold-storage-worker.ts",
      "src/config/sessions/session-entry-read.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-state-read.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  },
  {
    testFile: "src/agents/subagents/registry/subagent-reset.lifecycle.test.ts",
    watchGlobs: [
      "src/config/sessions/session-transcript-projection-publication.worker.ts",
      "src/config/sessions/session-transcript-reconcile.worker.ts",
      "src/config/sessions/session-transcript.worker.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  },
  {
    testFile: "src/agents/subagents/spawn/subagent-spawn.authority.test.ts",
    watchGlobs: ["src/state/openclaw-state.worker.ts"],
  },
  ...[
    "src/agents/workspace-state-read.worker.test.ts",
    "src/agents/workspace-state-store.test.ts",
    "src/gateway/session-swarm-summary.test.ts",
    "src/gateway/session-utils-profile-reference.test.ts",
    "src/gateway/session-utils.filters.test.ts",
    "src/infra/update-run-reader.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: ["src/state/openclaw-state-read.worker.ts"],
  })),
  ...["src/agents/worktrees/capacity.test.ts", "src/agents/worktrees/service.orphans.test.ts"].map(
    (testFile): PolicyTestWatch => ({
      testFile,
      watchGlobs: [
        "src/agents/worktrees/capacity.runtime.ts",
        "src/agents/worktrees/git-worktree-operations.runtime.ts",
        "src/agents/worktrees/registry-read.worker.ts",
        "src/infra/git-operation.worker.ts",
        "src/state/openclaw-state.worker.ts",
      ],
    }),
  ),
  ...[
    "src/agents/worktrees/empty-source.test.ts",
    "src/agents/worktrees/service.remove-lease.test.ts",
    "src/agents/worktrees/service.run-end-cleanup.test.ts",
    "src/agents/worktrees/service.snapshot-index.test.ts",
    "src/agents/worktrees/service.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/agents/worktrees/capacity.runtime.ts",
      "src/agents/worktrees/git-worktree-operations.runtime.ts",
      "src/agents/worktrees/registry-read.worker.ts",
      "src/agents/worktrees/snapshot-inventory.ts",
      "src/infra/git-operation.worker.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  })),
  {
    testFile: "src/agents/worktrees/service.canonical-paths.test.ts",
    watchGlobs: [
      "src/agents/worktrees/git-worktree-operations.runtime.ts",
      "src/agents/worktrees/registry-read.worker.ts",
      "src/infra/git-operation.worker.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  },
  ...[
    "src/auto-reply/reply/commands-login.consent.test.ts",
    "src/auto-reply/reply/commands-login.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "extensions/openai/openclaw.plugin.json",
      "extensions/openai/package.json",
      "extensions/openrouter/openclaw.plugin.json",
      "extensions/openrouter/package.json",
    ],
  })),
  {
    testFile: "src/auto-reply/reply/get-reply.dashboard.test.ts",
    watchGlobs: ["skills/control-ui/SKILL.md"],
  },
  ...[
    "src/boards/board-generated-identity.test.ts",
    "src/boards/board-store.parity.test.ts",
    "src/boards/board-store.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: ["src/boards/sqlite-board-store.worker.ts"],
  })),
  ...[
    "src/cli/capability-cli/model.account-secrets.provenance.test.ts",
    "src/commands/models/list.probe.resources.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: ["src/agents/prepared-model-catalog.worker.ts"],
  })),
  {
    testFile: "src/cli/claws-authoring-state.process.test.ts",
    watchGlobs: [
      "src/cli/claws-cli.project.ts",
      "src/cli/command-startup-policy.ts",
      "src/entry.ts",
    ],
  },
  ...[
    "src/cli/completion-cli.shadowed-options.process.test.ts",
    "src/cli/state-dir-gateway-check.process.test.ts",
    "src/infra/openclaw-cli-shim.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: ["src/entry.ts"],
  })),
  {
    testFile: "src/cli/cron-output.process.test.ts",
    watchGlobs: [
      "src/cli/cron-cli.ts",
      "src/cli/cron-cli/register.ts",
      "src/cli/json-output-mode.ts",
      "src/cli/one-shot-exit.ts",
      "src/cli/program/json-mode.ts",
    ],
  },
  {
    testFile: "src/cli/gateway-cli/run-loop.direct-stop-active-work.process.test.ts",
    watchGlobs: [
      "src/agents/embedded-agent-runner/active-run-projections.ts",
      "src/agents/embedded-agent-runner/runs.ts",
      "src/channels/message/ingress-drain.ts",
      "src/channels/message/ingress-queue.ts",
      "src/cli/gateway-cli/run-loop.ts",
      "src/process/gateway-work-admission.ts",
    ],
  },
  {
    testFile: "src/cli/hooks-cli.process.test.ts",
    watchGlobs: [
      "src/cli/hooks-cli.ts",
      "src/cli/native-hook-relay-cli.ts",
      "src/cli/native-hook-relay-entry.ts",
      "src/entry.ts",
    ],
  },
  {
    testFile: "src/cli/skills-cli.verify.process.test.ts",
    watchGlobs: [
      "src/cli/one-shot-exit.ts",
      "src/cli/skills-cli.ts",
      "src/entry.ts",
      "src/process/output-drain.ts",
    ],
  },
  {
    testFile: "src/commands/agents.identity.persistence.test.ts",
    watchGlobs: ["extensions/nextcloud-talk/assets/icon.png"],
  },
  {
    testFile: "src/commands/doctor-agent-memory-schema.test.ts",
    watchGlobs: ["src/infra/sqlite-integrity.worker.ts"],
  },
  ...[
    "src/commands/doctor-auth-flat-profiles.test.ts",
    "src/commands/doctor-session-state-providers.test.ts",
    "src/commands/doctor-state-integrity.transcripts.test.ts",
    "src/commands/doctor/auth-alias-preservation.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: ["src/config/sessions/session-transcript.worker.ts"],
  })),
  {
    testFile: "src/commands/doctor-heartbeat-source-archive.test.ts",
    watchGlobs: [
      "src/cron/store/dispatch.worker.ts",
      "src/cron/store/load.worker.ts",
      "src/cron/store/runtime-mutation.worker.ts",
    ],
  },
  {
    testFile: "src/commands/doctor-lint.oauth.test.ts",
    watchGlobs: ["src/agents/mcp-oauth-store.worker.ts"],
  },
  {
    testFile: "src/commands/doctor-maintenance.worker.test.ts",
    watchGlobs: [
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  },
  {
    testFile: "src/commands/doctor-sandbox-legacy-registry.test.ts",
    watchGlobs: [
      "src/agents/sandbox/registry-import.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  },
  ...[
    "src/commands/doctor-skill-workshop-relocation.reservations.test.ts",
    "src/commands/doctor-skill-workshop-sqlite.relocation.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: ["src/skills/workshop/store.worker.ts"],
  })),
  {
    testFile: "src/commands/models/auth.minimax-chat.test.ts",
    watchGlobs: [
      "extensions/minimax/index.ts",
      "extensions/minimax/oauth.runtime.ts",
      "extensions/minimax/oauth.ts",
      "extensions/minimax/provider-registration.ts",
    ],
  },
  {
    testFile: "src/commands/status.memory-presence.worker.test.ts",
    watchGlobs: [
      "extensions/memory-core/src/memory/manager-cpu-worker-runtime.ts",
      "extensions/memory-core/src/memory/manager-search.worker.ts",
      "extensions/memory-core/src/memory/manager-status-presence.runtime.ts",
      "extensions/memory-core/src/memory/manager-status-presence.ts",
      "extensions/memory-core/status-api.ts",
    ],
  },
  {
    testFile: "src/commands/triage-failure-process.test.ts",
    watchGlobs: ["scripts/tsx.mjs"],
  },
  ...[
    "src/config/io.factory.test.ts",
    "src/config/io.observe-freshness.test.ts",
    "src/config/legacy.roster.test.ts",
    "src/config/utility-model-separation-migration.io.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-state-read.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  })),
  ...[
    "src/config/sessions/cleanup-service.fix-missing.test.ts",
    "src/config/sessions/legacy-main-session-migration.input-handoff.test.ts",
    "src/config/sessions/legacy-main-session-migration.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/config/sessions/session-accessor.sqlite-archive.worker.ts",
      "src/config/sessions/session-transcript.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-agent-execution.worker.ts",
    ],
  })),
  ...[
    "src/config/sessions/goals.test.ts",
    "src/config/sessions/incognito-session-transcript.test.ts",
    "src/config/sessions/session-accessor.sqlite-active-events.test.ts",
    "src/config/sessions/session-accessor.sqlite-byte-size.test.ts",
    "src/config/sessions/session-accessor.sqlite-handle-lifecycle.test.ts",
    "src/config/sessions/session-accessor.sqlite-replacement-projection.test.ts",
    "src/config/sessions/transcript.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/config/sessions/session-transcript-projection-publication.worker.ts",
      "src/config/sessions/session-transcript-reconcile.worker.ts",
      "src/config/sessions/session-transcript.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-agent-execution.worker.ts",
    ],
  })),
  ...[
    "src/config/sessions/session-accessor.pending-inputs.test.ts",
    "src/config/sessions/session-accessor.question-answer-transcript.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/config/sessions/session-transcript-reconcile.worker.ts",
      "src/config/sessions/session-transcript.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-agent-execution.worker.ts",
    ],
  })),
  {
    testFile: "src/config/sessions/session-accessor.sqlite-deletion.test.ts",
    watchGlobs: [
      "src/config/sessions/session-accessor.sqlite-archive.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-agent-execution.worker.ts",
    ],
  },
  ...[
    "src/config/sessions/session-accessor.sqlite-participants.test.ts",
    "src/config/sessions/session-logical-entry-read.worker.test.ts",
    "src/gateway/session-activity-summaries.retry.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/config/sessions/session-transcript.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-agent-execution.worker.ts",
    ],
  })),
  {
    testFile: "src/config/sessions/session-accessor.sqlite-reclamation-memory.test.ts",
    watchGlobs: [
      "extensions/memory-core/src/memory/manager-index.worker.ts",
      "extensions/memory-core/src/memory/manager-publication.worker.ts",
      "extensions/memory-core/src/memory/manager.ts",
      "src/config/sessions/session-accessor.sqlite-archive.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-agent-execution.worker.ts",
    ],
  },
  ...[
    "src/config/sessions/session-accessor.sqlite-transcript-suffix.test.ts",
    "src/config/sessions/session-transcript-context-eligibility.test.ts",
    "src/config/sessions/session-transcript-reconcile.native-exit.test.ts",
    "src/config/sessions/session-transcript-reconcile.publication.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/config/sessions/session-transcript-projection-publication.worker.ts",
      "src/config/sessions/session-transcript-reconcile.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-agent-execution.worker.ts",
    ],
  })),
  ...[
    "src/fleet/doctor.runtime.test.ts",
    "src/fleet/registry-read.test.ts",
    "src/fleet/service-removal.runtime.test.ts",
    "src/fleet/service-upgrade.runtime.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/fleet/registry.kernel.ts",
      "src/fleet/registry.worker.ts",
      "src/state/openclaw-state-read-registry.ts",
      "src/state/openclaw-state-read.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  })),
  {
    testFile: "src/gateway/board-store.test.ts",
    watchGlobs: [
      "src/boards/sqlite-board-store.worker.ts",
      "src/config/sessions/session-transcript.worker.ts",
    ],
  },
  ...[
    "src/gateway/exec-approval-manager.test.ts",
    "src/gateway/operator-approval-placement-grants.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: ["src/gateway/operator-approval-store.worker.ts"],
  })),
  {
    testFile: "src/gateway/gateway-ssh-upload-signal.test.ts",
    watchGlobs: ["scripts/run-node.mjs", "src/cli/gateway-cli/run.ts", "src/entry.ts"],
  },
  {
    testFile: "src/gateway/local-request-context.test.ts",
    watchGlobs: ["src/cron/store/load.worker.ts", "src/cron/store/save.worker.ts"],
  },
  ...[
    "src/gateway/managed-outgoing-gc-availability.test.ts",
    "src/plugin-sdk/memory-host-core.test.ts",
    "src/plugin-sdk/memory-host-events.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: ["src/state/openclaw-state.worker.ts"],
  })),
  {
    testFile: "src/gateway/operator-approval-store.execution-identity.test.ts",
    watchGlobs: [
      "src/gateway/operator-approval-store.worker.ts",
      "src/infra/sqlite-store.worker.ts",
    ],
  },
  ...[
    "src/gateway/server-methods/board.plugin-capabilities.test.ts",
    "src/gateway/server-methods/board.runtime-boundaries.test.ts",
    "src/gateway/server-methods/board.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/boards/sqlite-board-store.worker.ts",
      "src/config/sessions/session-transcript.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-state-read.worker.ts",
    ],
  })),
  {
    testFile: "src/gateway/server-methods/board.website.test.ts",
    watchGlobs: ["src/boards/sqlite-board-store.worker.ts", "src/infra/sqlite-store.worker.ts"],
  },
  ...[
    "src/gateway/server-methods/chat-history-handler.cli-import.test.ts",
    "src/gateway/server-methods/chat-history-registry.test.ts",
    "src/gateway/server-methods/chat-startup-short-reference.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/config/sessions/session-transcript-projection-publication.worker.ts",
      "src/config/sessions/session-transcript.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-state-read.worker.ts",
    ],
  })),
  {
    testFile: "src/gateway/server-methods/chat.abort-errors.test.ts",
    watchGlobs: [
      "src/config/sessions/session-transcript-projection-publication.worker.ts",
      "src/config/sessions/session-transcript.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-state-read.worker.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  },
  {
    testFile: "src/gateway/server-methods/cron.runs.test.ts",
    watchGlobs: [
      "src/cron/store/read-only.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  },
  {
    testFile: "src/gateway/server-methods/nodes.test.ts",
    watchGlobs: [
      "src/infra/device-pairing-dispatch.worker.ts",
      "src/infra/push-apns-store.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  },
  {
    testFile: "src/gateway/server-methods/plugin-approval.test.ts",
    watchGlobs: [
      "src/gateway/operator-approval-store.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  },
  {
    testFile: "src/gateway/server-methods/plugins.reload-readonly.test.ts",
    watchGlobs: ["src/infra/sqlite-store.worker.ts", "src/state/openclaw-state.worker.ts"],
  },
  {
    testFile: "src/gateway/server-methods/projects-recents.test.ts",
    watchGlobs: [
      "src/config/sessions/session-transcript.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-state-read.worker.ts",
      "src/state/user-profiles.worker.ts",
    ],
  },
  {
    testFile: "src/gateway/server-methods/send.scheduled-reads.integration.test.ts",
    watchGlobs: ["extensions/discord/api.ts"],
  },
  ...[
    "src/gateway/server-methods/sessions-describe-catalog.test.ts",
    "src/gateway/server-methods/sessions-list-archived.test.ts",
    "src/gateway/server-methods/sessions-mutations.perf.test.ts",
    "src/gateway/server-methods/sessions-read-active.test.ts",
    "src/gateway/server-methods/sessions-read-async.test.ts",
    "src/gateway/server-methods/sessions-read-diagnostics.test.ts",
    "src/gateway/server-methods/sessions-read-visibility.test.ts",
    "src/gateway/server-methods/sessions-read.test.ts",
    "src/gateway/server-methods/sessions-row-projection.sqlite.test.ts",
    "src/gateway/server-methods/sessions-sharing.identities.test.ts",
    "src/gateway/server-methods/sessions-sharing.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/config/sessions/session-transcript.worker.ts",
      "src/state/openclaw-agent-execution.worker.ts",
      "src/state/openclaw-state-read.worker.ts",
    ],
  })),
  {
    testFile: "src/gateway/server-methods/sessions-read-catalog-scope.test.ts",
    watchGlobs: [
      "extensions/openai/openclaw.plugin.json",
      "extensions/openai/provider-policy-api.ts",
      "src/config/sessions/session-transcript.worker.ts",
      "src/state/openclaw-agent-execution.worker.ts",
      "src/state/openclaw-state-read.worker.ts",
    ],
  },
  {
    testFile: "src/gateway/server-methods/system-agent-approval.test.ts",
    watchGlobs: [
      "src/gateway/operator-approval-store.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-state-read.worker.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  },
  {
    testFile: "src/gateway/server-methods/system-agent.host-lifecycle.test.ts",
    watchGlobs: [
      "src/gateway/operator-approval-store.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  },
  {
    testFile: "src/gateway/session-companion-context.test.ts",
    watchGlobs: [
      "src/config/sessions/session-transcript-projection-publication.worker.ts",
      "src/config/sessions/session-transcript-reconcile.worker.ts",
    ],
  },
  ...[
    "src/gateway/session-history.subagent-visibility.test.ts",
    "src/gateway/session-transcript-readers.markers.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/config/sessions/session-transcript.worker.ts",
      "src/infra/sqlite-store.worker.ts",
    ],
  })),
  ...[
    "src/gateway/session-row-projection.membership.test.ts",
    "src/gateway/session-utils.single-row-cache.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/config/sessions/session-transcript.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-state-read.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  })),
  {
    testFile: "src/gateway/session-sharing-store-cache.test.ts",
    watchGlobs: [
      "src/config/sessions/session-sharing-store.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-agent-execution.worker.ts",
    ],
  },
  {
    testFile: "src/gateway/session-transcript-preview.hydration.test.ts",
    watchGlobs: [
      "src/config/sessions/session-accessor.sqlite-archive.worker.ts",
      "src/config/sessions/session-cold-storage-worker.ts",
      "src/config/sessions/session-transcript-reconcile.worker.ts",
      "src/config/sessions/session-transcript.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-agent-execution.worker.ts",
    ],
  },
  ...["src/gateway/session-utils.agent-models.test.ts", "src/gateway/session-utils.test.ts"].map(
    (testFile): PolicyTestWatch => ({
      testFile,
      watchGlobs: [
        "src/state/openclaw-state-worker-runtime.ts",
        "src/state/openclaw-state.worker.ts",
      ],
    }),
  ),
  {
    testFile: "src/gateway/session-utils.perf.test.ts",
    watchGlobs: [
      "src/config/sessions/session-accessor.sqlite-archive.worker.ts",
      "src/state/openclaw-state-read.worker.ts",
    ],
  },
  {
    testFile: "src/gateway/session-utils.queued-collector.test.ts",
    watchGlobs: [
      "src/config/sessions/session-accessor.sqlite-archive.worker.ts",
      "src/config/sessions/session-transcript.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-state-read.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  },
  {
    testFile: "src/gateway/talk/client-authority.test.ts",
    watchGlobs: [
      "src/config/sessions/session-entry-read.worker.ts",
      "src/config/sessions/session-transcript.worker.ts",
    ],
  },
  ...[
    "src/gateway/talk/client-spoken-confirmation.test.ts",
    "src/gateway/talk/handlers/client-native-control.test.ts",
    "src/gateway/talk/handlers/native-consult-target.test.ts",
    "src/gateway/talk/handlers/target.test.ts",
    "src/gateway/talk/handlers/voice.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/config/sessions/session-entry-read.worker.ts",
      "src/config/sessions/session-transcript-reconcile.worker.ts",
      "src/config/sessions/session-transcript.worker.ts",
    ],
  })),
  {
    testFile: "src/gateway/worker-environments/node-worker-repository-sync.test.ts",
    watchGlobs: [
      "src/infra/git-operation.worker.ts",
      "src/node-host/node-worker-journal.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  },
  ...[
    "src/gateway/worker-environments/placement-move-abandon.test.ts",
    "src/gateway/worker-environments/prepared-pool-build.test.ts",
    "src/gateway/worker-environments/provider-destroy-timeout.test.ts",
    "src/gateway/worker-environments/provider-provisioning.test.ts",
    "src/gateway/worker-environments/repository-project-access.test.ts",
    "src/gateway/worker-environments/store-retention.test.ts",
    "src/gateway/worker-environments/worker-turn-launcher.claim-recovery.test.ts",
    "src/gateway/worker-environments/worker-turn-rpc.portal.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/gateway/worker-environments/store.kernel.ts",
      "src/gateway/worker-environments/store.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  })),
  ...[
    "src/gateway/worker-environments/prepared-pool-local-project.test.ts",
    "src/gateway/worker-environments/provider-intent.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/gateway/worker-environments/store.kernel.ts",
      "src/gateway/worker-environments/store.worker.ts",
      "src/infra/git-operation.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  })),
  {
    testFile: "src/infra/backup-create.audit.test.ts",
    watchGlobs: ["src/infra/sqlite-readonly-location.worker.ts"],
  },
  {
    testFile: "src/infra/device-bootstrap.test.ts",
    watchGlobs: [
      "src/infra/device-bootstrap.worker-kernel.ts",
      "src/infra/device-pairing-dispatch.worker.ts",
      "src/infra/device-pairing-mutation.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-state-read.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  },
  {
    testFile: "src/infra/device-pairing-node-desktop-migration.test.ts",
    watchGlobs: [
      "src/infra/device-pairing-dispatch.worker.ts",
      "src/infra/device-pairing-node.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  },
  {
    testFile: "src/infra/device-pairing-node.test.ts",
    watchGlobs: [
      "src/infra/device-pairing-dispatch.worker.ts",
      "src/infra/device-pairing-mutation.worker.ts",
      "src/infra/device-pairing-node.worker.ts",
      "src/infra/device-pairing-read.kernel.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-state-read.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  },
  ...[
    "src/infra/heartbeat-runner.clears-pending-final-delivery.test.ts",
    "src/infra/heartbeat-runner.committed-work.test.ts",
    "src/infra/heartbeat-runner.isolated-session-mirror.test.ts",
    "src/infra/heartbeat-runner.typing.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/config/sessions/session-transcript-projection-publication.worker.ts",
      "src/config/sessions/session-transcript.worker.ts",
      "src/state/openclaw-agent-execution.worker.ts",
    ],
  })),
  ...[
    "src/infra/outbound/conversation-delivery.queue-admission.test.ts",
    "src/infra/outbound/delivery-queue-entry-state.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/infra/delivery-queue.worker.ts",
      "src/infra/outbound/delivery-queue-ack.worker.ts",
      "src/infra/outbound/delivery-queue-enqueue.worker.ts",
      "src/infra/outbound/delivery-queue-platform-lease.worker.ts",
      "src/infra/outbound/delivery-queue-storage.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  })),
  {
    testFile: "src/infra/push-web.test.ts",
    watchGlobs: [
      "src/infra/push-web-store.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  },
  ...[
    "src/infra/session-delivery-queue-runtime.test.ts",
    "src/infra/session-delivery-queue.storage.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/infra/session-delivery-queue.worker.ts",
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  })),
  {
    testFile: "src/infra/sqlite-worker-store.existing.test.ts",
    watchGlobs: ["src/infra/sqlite-store.worker.ts"],
  },
  ...[
    "src/infra/sqlite-worker-transcripts.test.ts",
    "src/meeting-bot/transcripts-bridge.test.ts",
    "src/transcripts/status.producer.shutdown.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
      "src/transcripts/store-sqlite-read.ts",
      "src/transcripts/store-sqlite-write.ts",
      "src/transcripts/store-worker-read.ts",
      "src/transcripts/store-worker-write.ts",
    ],
  })),
  ...[
    "src/infra/state-migrations.caller-mode.execution.test.ts",
    "src/infra/state-migrations.plan.test.ts",
    "src/infra/state-migrations.recoverable-legacy-state.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: ["src/infra/state-migrations.snapshot.worker.ts"],
  })),
  {
    testFile: "src/infra/telemetry.test.ts",
    watchGlobs: [
      "src/infra/sqlite-store.worker.ts",
      "src/infra/telemetry-store.kernel.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  },
  ...[
    "src/infra/update-candidate-bundled-provenance.test.ts",
    "src/infra/update-candidate-plugin-sources.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: ["src/infra/update-candidate-state.worker.ts"],
  })),
  {
    testFile: "src/infra/update-candidate-rehearsal.resources.test.ts",
    watchGlobs: [
      "src/infra/sqlite-readonly-location.worker.ts",
      "src/infra/update-candidate-state.worker.ts",
    ],
  },
  {
    testFile: "src/node-host/node-worker-workspace-retention.test.ts",
    watchGlobs: [
      "src/infra/sqlite-store.worker.ts",
      "src/node-host/node-worker-journal.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  },
  {
    testFile: "src/plugin-sdk/persistent-dedupe.worker.test.ts",
    watchGlobs: ["src/plugin-state/plugin-state.worker.ts"],
  },
  {
    testFile: "src/plugin-sdk/session-transcript-runtime.catalog.test.ts",
    watchGlobs: [
      "src/config/sessions/session-cold-storage-worker.ts",
      "src/config/sessions/session-transcript-reconcile.worker.ts",
    ],
  },
  {
    testFile: "src/plugin-sdk/session-transcript-runtime.read-fence.test.ts",
    watchGlobs: ["src/config/sessions/session-transcript-reconcile.worker.ts"],
  },
  ...[
    "src/plugin-state/plugin-blob-store.readonly.test.ts",
    "src/plugin-state/plugin-blob-store.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/plugin-state/plugin-blob-store.worker.ts",
      "src/state/openclaw-state-read.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  })),
  {
    testFile: "src/process/supervisor/service-child-group-anchor.retirement.test.ts",
    watchGlobs: ["src/process/supervisor/service-child-group-anchor.ts"],
  },
  {
    testFile: "src/process/supervisor/service-child-relay-host.retirement.test.ts",
    watchGlobs: [
      "src/process/supervisor/service-child-group-anchor.ts",
      "src/process/supervisor/service-child-relay.ts",
    ],
  },
  {
    testFile: "src/projects/project-registry.test.ts",
    watchGlobs: [
      "src/projects/project-registry.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  },
  {
    testFile: "src/sessions/session-upstream-monitor.test.ts",
    watchGlobs: [
      "src/state/openclaw-state-read-registry.ts",
      "src/state/openclaw-state-read.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  },
  {
    testFile: "src/skills/library/persistence.test.ts",
    watchGlobs: ["src/skills/library/persistence-child.test-support.ts"],
  },
  {
    testFile: "src/skills/workshop/experience-review.apply.test.ts",
    watchGlobs: [
      "src/infra/sqlite-store.worker.ts",
      "src/skills/workshop/curator.kernel.ts",
      "src/skills/workshop/store-proposal.kernel.ts",
      "src/skills/workshop/store.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
    ],
  },
  {
    testFile: "src/state/openclaw-agent-participants-migration.test.ts",
    watchGlobs: ["test/fixtures/sqlite/openclaw-agent-schema-v22.sql"],
  },
  {
    testFile: "src/state/openclaw-database-preflight.explicit-file.test.ts",
    watchGlobs: [
      "src/infra/sqlite-readonly-location.worker.ts",
      "src/infra/sqlite-source-revision.worker.ts",
      "src/state/openclaw-agent-schema-inspection.ts",
      "src/state/openclaw-agent-schema-inspection.worker.ts",
    ],
  },
  {
    testFile: "src/state/openclaw-database-preflight.startup-integrity.test.ts",
    watchGlobs: [
      "src/infra/sqlite-integrity.worker.ts",
      "src/infra/sqlite-readonly-location.worker.ts",
      "src/infra/sqlite-source-revision.worker.ts",
      "src/state/openclaw-agent-schema-inspection.ts",
      "src/state/openclaw-agent-schema-inspection.worker.ts",
      "src/state/openclaw-database-verify.worker.ts",
    ],
  },
  {
    testFile: "src/state/user-profiles.avatar-worker.test.ts",
    watchGlobs: [
      "src/infra/sqlite-store.worker.ts",
      "src/state/openclaw-state-read.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state.worker.ts",
      "src/state/user-profiles.worker.ts",
    ],
  },
  ...[
    "src/system-agent/chat-turn-router.approval.test.ts",
    "src/system-agent/config-redaction.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "extensions/buzz/openclaw.plugin.json",
      "extensions/buzz/src/config-schema.ts",
      "extensions/buzz/src/target.ts",
      "extensions/codex/openclaw.plugin.json",
      "extensions/synology-chat/openclaw.plugin.json",
      "extensions/synology-chat/src/config-schema.ts",
      "extensions/telegram/openclaw.plugin.json",
      "extensions/telegram/src/command-config.ts",
      "extensions/telegram/src/config-schema.ts",
      "extensions/telegram/src/config-ui-hints.ts",
    ],
  })),
  {
    testFile: "src/system-agent/setup-inference.groq-external.integration.test.ts",
    watchGlobs: ["src/plugin-sdk/provider-entry.ts", "src/plugin-sdk/provider-model-metadata.ts"],
  },
  {
    testFile: "src/system-agent/setup-lifetime.test.ts",
    watchGlobs: [
      "docs/reference/templates/AGENTS.md",
      "docs/reference/templates/BOOTSTRAP.md",
      "docs/reference/templates/IDENTITY.md",
      "docs/reference/templates/SOUL.md",
      "docs/reference/templates/USER.md",
    ],
  },
  {
    testFile: "src/tts/tts-summary.static-catalog.test.ts",
    watchGlobs: ["extensions/kimi-coding/openclaw.plugin.json"],
  },
  {
    testFile: "test/e2e/qa-lab/runtime/gateway-support-export-runtime.test.ts",
    watchGlobs: ["src/cli/gateway-cli/register.ts"],
  },
  {
    testFile: "test/scripts/ci-git-owner-auth.test.ts",
    watchGlobs: [
      ".github/actions/git-owner/owner.py",
      ".github/workflows/openclaw-performance.yml",
      ".github/workflows/qa-live-transports-convex.yml",
    ],
  },
  {
    testFile: "test/scripts/cli-startup-bench-spawner.test.ts",
    watchGlobs: ["scripts/bench-cli-startup.ts", "scripts/ensure-cli-startup-build.mts"],
  },
  {
    testFile: "test/scripts/upgrade-survivor-installed-version.test.ts",
    watchGlobs: ["scripts/e2e/lib/upgrade-survivor/run.sh"],
  },
  // Native maintainer fixtures copy and launch their shell owner instead of importing it.
  ...[
    "test/scripts/pr-correction-preparation.test.ts",
    "test/scripts/pr-host-tools.test.ts",
    "test/scripts/pr-main-refresh.test.ts",
    "test/scripts/pr-merge-auto-recovery.test.ts",
    "test/scripts/pr-merge-body-provenance.test.ts",
    "test/scripts/pr-merge-completion.test.ts",
    "test/scripts/pr-merge-hosted.test.ts",
    "test/scripts/pr-merge-legacy-recovery.test.ts",
    "test/scripts/pr-merge-qualified-refusal.test.ts",
    "test/scripts/pr-publication.test.ts",
    "test/scripts/pr-wrappers.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "scripts/pr",
      "scripts/pr-{merge,prepare,review}",
      "scripts/pr-lib/**",
      "scripts/lib/plain-gh.{sh,mjs}",
      "scripts/lib/tsx-cli-shim.mjs",
      "scripts/tsx.mjs",
      "scripts/verify-pr-hosted-gates.{mjs,mts}",
    ],
  })),
  {
    testFile: "extensions/browser/chrome-extension/background.fetch-continuation.test.ts",
    watchGlobs: [
      "extensions/browser/chrome-extension/background.js",
      "extensions/browser/chrome-extension/modules/relay-command-handler.js",
    ],
  },
  {
    testFile: "extensions/crabbox/src/crabbox-worker-desktop-windows.test.ts",
    watchGlobs: ["extensions/crabbox/src/crabbox-worker-provider.ts"],
  },
  {
    testFile: "extensions/imessage/src/send.sqlite.test.ts",
    watchGlobs: ["extensions/imessage/src/chat-db.worker.ts"],
  },
  {
    testFile: "extensions/logbook/src/store-batch-images.test.ts",
    watchGlobs: ["extensions/logbook/src/store.worker.ts"],
  },
  {
    testFile: "extensions/qa-lab/src/profile-evidence-sharding.test.ts",
    watchGlobs: ["qa/scenarios/**", "taxonomy.yaml"],
  },
  {
    testFile: "extensions/qa-lab/src/scenario-catalog.delegation.test.ts",
    watchGlobs: ["qa/scenarios/channels/system-agent-delegation-generation.yaml"],
  },
  {
    testFile: "extensions/qa-lab/src/scenario-flow-runner.test.ts",
    watchGlobs: ["qa/scenarios/**"],
  },
  {
    testFile: "extensions/qa-lab/src/test-file-scenario-runner.child-bundle.test.ts",
    watchGlobs: ["extensions/qa-lab/test-api.ts"],
  },
  {
    testFile: "src/commands/doctor-config-flow.canvas-migration.test.ts",
    watchGlobs: ["extensions/canvas/src/config-migration.ts"],
  },
  {
    testFile: "src/gateway/gateway-active-memory.test.ts",
    watchGlobs: ["extensions/active-memory/recall.ts"],
  },
  {
    testFile: "src/gateway/worker-environments/store-runtime-refresh.test.ts",
    watchGlobs: [
      "src/gateway/worker-environments/store-transitions.ts",
      "src/gateway/worker-environments/store.kernel.ts",
    ],
  },
  {
    testFile: "test/scripts/bench-gateway-installed.test.ts",
    watchGlobs: [
      "scripts/bench-gateway-startup.ts",
      "scripts/lib/gateway-bench-child.ts",
      "scripts/lib/gateway-bench-installed.ts",
      "scripts/lib/gateway-bench-probes.ts",
      "scripts/lib/gateway-bench-runtime.ts",
      "scripts/lib/gateway-bench-stop-preload.mjs",
      "scripts/lib/gateway-ws-client.ts",
    ],
  },
  {
    testFile: "test/scripts/full-release-publication-admission.test.ts",
    watchGlobs: [
      "scripts/full-release-validation-state.mjs",
      "scripts/lib/plugin-npm-release.ts",
      "scripts/lib/release-publish-children.sh",
      "scripts/release-plan-producer.mts",
    ],
  },
  {
    testFile: "test/scripts/managed-child-process.test.ts",
    watchGlobs: ["scripts/lib/bounded-command.mts"],
  },
  {
    testFile: "test/scripts/vitest-report-owner.test.ts",
    watchGlobs: [
      "scripts/lib/vitest-report-capture.mts",
      "scripts/run-vitest.mts",
      "scripts/test-extension-batch.mts",
      "scripts/test-projects-run.mts",
    ],
  },
  {
    testFile: "src/gateway/server.models-native-retirement.test.ts",
    watchGlobs: ["extensions/xai/openclaw.plugin.json"],
  },
  {
    testFile: "src/gateway/gateway-concurrent-streams.test.ts",
    watchGlobs: [
      "src/gateway/openai-http.ts",
      "src/gateway/openresponses-http.ts",
      "src/gateway/openai-compatible-agent-run.ts",
      "src/gateway/server-chat.ts",
      "src/gateway/server-runtime-subscriptions.ts",
      "src/infra/agent-events.ts",
      "scripts/e2e/mock-openai-server.mjs",
    ],
  },
  {
    testFile: "src/infra/outbound/delivery-queue.reconnect-drain.test.ts",
    watchGlobs: [
      "src/infra/outbound/delivery-queue-storage.worker.ts",
      "src/infra/outbound/delivery-queue-platform-lease.worker.ts",
      "src/infra/outbound/delivery-queue-ack.worker.ts",
      "src/infra/delivery-queue.worker.ts",
    ],
  },
  {
    testFile: "src/infra/outbound/deliver-queue.cancellation-integration.test.ts",
    watchGlobs: [
      "src/infra/outbound/delivery-queue-ack.kernel.ts",
      "src/infra/outbound/delivery-queue-storage.worker.ts",
      "src/infra/outbound/delivery-queue-platform-lease.worker.ts",
      "src/infra/delivery-queue.worker.ts",
    ],
  },
  {
    testFile: "src/cron/service/owner-hardening.test.ts",
    watchGlobs: ["src/cron/store/run-admission.worker.ts"],
  },
  {
    testFile: "test/e2e/qa-lab/runtime/gateway-codex-delivery-cache.test.ts",
    watchGlobs: [
      "extensions/codex/src/app-server/turn-params.ts",
      "extensions/codex/src/app-server/dynamic-tools.ts",
    ],
  },
  {
    testFile: "extensions/matrix/doctor-contract-api.account-state.test.ts",
    watchGlobs: [
      "extensions/matrix/doctor-contract-api.ts",
      "extensions/matrix/src/matrix/account-state-schema-doctor.ts",
      "extensions/matrix/src/matrix/state-layout-walk.ts",
    ],
  },
  ...[
    "extensions/memory-core/src/memory/index.test.ts",
    "extensions/memory-core/src/memory/manager-search-provenance.test.ts",
    "extensions/memory-core/src/memory/manager-temporal-ranking.test.ts",
    "extensions/memory-core/src/memory/manager.watcher-filesystem.test.ts",
    "extensions/memory-core/src/tools.index-upgrade.test.ts",
    "extensions/memory-core/src/memory/manager-candidate-repair.test.ts",
    "extensions/memory-core/src/memory/manager-keyword-retrieval.test.ts",
    "extensions/memory-core/src/memory/manager-search-orchestration.test.ts",
    "extensions/memory-core/src/memory/manager-search-monotonicity.test.ts",
    "extensions/memory-core/src/memory/manager-session-update-race.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "extensions/memory-core/src/memory/manager-index.worker.ts",
      "extensions/memory-core/src/memory/manager-search.worker.ts",
      "extensions/memory-core/src/memory/manager-publication.worker.ts",
    ],
  })),
  {
    testFile: "extensions/memory-core/src/memory/manager.reindex-recovery.test.ts",
    watchGlobs: [
      "extensions/memory-core/src/memory/manager-index.worker.ts",
      "extensions/memory-core/src/memory/manager-publication.worker.ts",
    ],
  },
  {
    testFile: "extensions/qa-lab/src/suite-process-lifecycle.test.ts",
    watchGlobs: ["src/index.ts"],
  },
  {
    testFile: "src/agents/agent-command-local.test.ts",
    watchGlobs: [
      "openclaw.mjs",
      "src/cli/program/register.agent-turn.ts",
      "src/commands/agent-via-gateway.ts",
      "extensions/litellm/index.ts",
      "extensions/litellm/provider-catalog.ts",
    ],
  },
  {
    testFile: "src/agents/embedded-agent-runner/run-orchestrator.projection.test.ts",
    watchGlobs: ["src/config/sessions/session-transcript-reconcile.worker.ts"],
  },
  ...[
    "src/agents/embedded-agent-runner/run/attempt-session-replay.test.ts",
    "src/config/sessions/session-accessor.sqlite-branches.test.ts",
    "src/gateway/session-message-events.test.ts",
    "src/gateway/worker-environments/worker-turn-execution.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: ["src/config/sessions/session-transcript.worker.ts"],
  })),
  ...[
    "src/agents/sessions/agent-session-code-mode-source.test.ts",
    "src/gateway/gateway-code-mode-clock.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: ["src/agents/code-mode-node.worker.ts"],
  })),
  {
    testFile: "src/cli/agent-session-affinity.process.test.ts",
    watchGlobs: [
      "src/entry.ts",
      "src/cli/program/register.agent.ts",
      "src/agents/agent-command.ts",
      "packages/ai/src/transports/openai-transport-params.ts",
      "packages/ai/src/transports/openai-completions-compat.ts",
      "packages/ai/src/providers/openai-completions.ts",
    ],
  },
  {
    testFile: "src/cli/doctor-output.process.test.ts",
    watchGlobs: ["src/entry.ts", "src/cli/program/register.maintenance.ts"],
  },
  {
    testFile: "src/cli/gateway-cli/run-loop.model-acquisition.process.test.ts",
    watchGlobs: [
      "src/cli/gateway-cli/run-loop.ts",
      "src/cli/gateway-cli/run-loop-shutdown-budget.ts",
      "src/cli/gateway-cli/shutdown-hard-exit.ts",
      "src/gateway/server-start.ts",
      "src/gateway/server-startup-model-runtime.ts",
      "src/agents/prepared-model-runtime.ts",
      "src/agents/prepared-model-runtime.startup-status.ts",
    ],
  },
  {
    testFile: "src/cli/mcp-cli.test.ts",
    watchGlobs: ["src/agents/mcp-stdio-client.ts"],
  },
  {
    testFile: "src/cli/update-dry-run-state.process.test.ts",
    watchGlobs: [
      "src/cli/update-cli.ts",
      "src/cli/update-cli/cleanup.ts",
      "src/cli/update-cli/update-command-migration-plan.ts",
      "src/cli/node-cli/register.ts",
      "src/node-host/worker.ts",
    ],
  },
  ...[
    "src/config/sessions/session-accessor.sqlite-archive-session.test.ts",
    "src/config/sessions/session-history-budget-owner.test.ts",
    "src/config/sessions/session-history-eviction.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: ["src/config/sessions/session-accessor.sqlite-archive.worker.ts"],
  })),
  {
    testFile: "src/config/sessions/session-accessor.sqlite-maintenance-worker.test.ts",
    watchGlobs: [
      "src/config/sessions/session-accessor.sqlite-archive.worker.ts",
      "src/config/sessions/session-accessor.sqlite-mutation-worker.runtime.ts",
    ],
  },
  {
    testFile: "src/config/sessions/session-accessor.sqlite-prepared-admission.test.ts",
    watchGlobs: [
      "src/infra/sqlite-integrity.worker.ts",
      "src/config/sessions/session-accessor.sqlite-archive.worker.ts",
    ],
  },
  {
    testFile: "src/config/sessions/session-history-eviction.admission.test.ts",
    watchGlobs: ["src/infra/sqlite-integrity.worker.ts"],
  },
  {
    testFile: "src/entry.memory-json.test.ts",
    watchGlobs: [
      "extensions/memory-core/src/cli.ts",
      "extensions/memory-core/src/cli-rem.runtime.ts",
      "extensions/memory-core/src/cli-index-search.runtime.ts",
      "extensions/memory-core/src/tools.ts",
      "extensions/memory-core/src/memory/manager-search-knn.ts",
      "extensions/memory-core/src/memory/manager-search-vector.ts",
    ],
  },
  {
    testFile: "src/gateway/control-ui-session-prs-branch.test.ts",
    watchGlobs: [
      "src/gateway/control-ui-session-prs-git.runtime.ts",
      "src/infra/git-read-operations.runtime.ts",
    ],
  },
  {
    testFile: "src/gateway/github-publication-transcript.test.ts",
    watchGlobs: ["src/config/sessions/session-accessor.sqlite-transcript-reports.worker.ts"],
  },
  {
    testFile: "src/gateway/mention-directory.test.ts",
    watchGlobs: ["src/state/user-profiles.worker.ts"],
  },
  {
    testFile: "src/gateway/operator-approval-mcp-grants.test.ts",
    watchGlobs: ["src/gateway/operator-approval-store.worker.ts"],
  },
  ...[
    "src/gateway/server-methods/models-auth-login.catalog.integration.test.ts",
    "src/gateway/server-methods/models-auth-refresh.catalog.integration.test.ts",
    "src/gateway/server-methods/models-dispatch.catalog.integration.test.ts",
    "src/gateway/server-methods/models-list.discovery-lifecycle.integration.test.ts",
    "src/gateway/server-methods/models-list.worker-recovery.integration.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: ["src/agents/prepared-model-catalog.worker.ts"],
  })),
  {
    testFile: "src/gateway/server-methods/session-catalog.performance.test.ts",
    watchGlobs: [
      "extensions/codex/src/session-catalog.ts",
      "extensions/codex/src/session-catalog-list-operation.ts",
      "extensions/codex/src/session-catalog-listing.ts",
      "extensions/codex/src/session-catalog-index.ts",
      "extensions/codex/src/session-catalog-index-query.ts",
    ],
  },
  {
    testFile: "src/gateway/server-startup-secret-owner-isolation.test.ts",
    watchGlobs: ["extensions/vault/vault-secret-ref-resolver.js"],
  },
  {
    testFile: "src/gateway/server.chat-cli-auth.test.ts",
    watchGlobs: [
      "extensions/anthropic/cli-auth-seam.ts",
      "extensions/anthropic/cli-backend.ts",
      "extensions/anthropic/cli.runtime.ts",
      "extensions/anthropic/cli-transport.ts",
      "extensions/anthropic/cli-process.ts",
    ],
  },
  {
    testFile: "src/gateway/server.startup-fixture-lifetime.test.ts",
    watchGlobs: [
      "src/gateway/server.ts",
      "src/gateway/server-kernel.ts",
      "src/gateway/server-lifecycle.ts",
      "src/gateway/server-shutdown.ts",
      "src/gateway/server/http-listen.ts",
      "src/plugins/plugin-metadata-lifecycle.ts",
    ],
  },
  {
    testFile: "src/gateway/server.xai-fallback.test.ts",
    watchGlobs: ["extensions/xai/index.ts"],
  },
  {
    testFile: "src/gateway/session-activity-summaries.test.ts",
    watchGlobs: ["src/config/sessions/session-cold-storage-worker.ts"],
  },
  {
    testFile: "src/gateway/session-delivery-clock-jump.integration.test.ts",
    watchGlobs: [
      "src/infra/session-delivery-queue.worker.ts",
      "src/state/openclaw-state.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
    ],
  },
  {
    testFile: "src/gateway/session-transcript-title-reader.test.ts",
    watchGlobs: [
      "src/config/sessions/session-cold-storage-worker.ts",
      "src/config/sessions/session-accessor.sqlite-archive.worker.ts",
      "src/config/sessions/session-transcript-reconcile.worker.ts",
    ],
  },
  {
    testFile: "src/gateway/setup-inference.first-signin.integration.test.ts",
    watchGlobs: [
      "extensions/github-copilot/index.ts",
      "extensions/github-copilot/login.ts",
      "extensions/github-copilot/starter-model.ts",
    ],
  },
  ...[
    "src/gateway/worker-environments/prepared-environment-store.test.ts",
    "src/gateway/worker-environments/prepared-pool.test.ts",
    "src/gateway/worker-environments/provider-allocation-cleanup.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [
      "src/gateway/worker-environments/store.worker.ts",
      "src/gateway/worker-environments/store.kernel.ts",
    ],
  })),
  {
    testFile: "src/gateway/worker-environments/provider-crabbox-runtime-preflight.test.ts",
    watchGlobs: [
      "extensions/crabbox/src/crabbox-worker-provider.ts",
      "extensions/crabbox/src/crabbox-worker-preflight.ts",
      "extensions/crabbox/src/crabbox-worker-provision-commands.ts",
      "src/gateway/worker-environments/store.worker.ts",
      "src/gateway/worker-environments/store.kernel.ts",
    ],
  },
  {
    testFile: "src/gateway/worker-environments/repository-workspace-startup.test.ts",
    watchGlobs: ["src/node-host/node-worker-journal.worker.ts"],
  },
  {
    testFile: "src/infra/outbound/deliver.queue-integration.test.ts",
    watchGlobs: [
      "src/infra/delivery-queue.worker.ts",
      "src/infra/outbound/delivery-queue-storage.worker.ts",
      "src/infra/outbound/delivery-queue-platform-lease.worker.ts",
      "src/infra/outbound/delivery-queue-ack.worker.ts",
      "src/infra/outbound/delivery-queue-enqueue.worker.ts",
    ],
  },
  {
    testFile: "src/infra/state-migrations.caller-mode.storage.test.ts",
    watchGlobs: ["src/infra/state-migrations.snapshot.worker.ts"],
  },
  {
    testFile: "src/infra/state-migrations.skill-workshop.test.ts",
    watchGlobs: ["src/state/openclaw-state.worker.ts"],
  },
  ...[
    "src/infra/update-candidate-state.test.ts",
    "src/infra/update-candidate-workspace-rehearsal.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: ["src/infra/update-candidate-state.worker.ts"],
  })),
  {
    testFile: "src/state/agent-database-admission.test.ts",
    watchGlobs: [
      "src/state/openclaw-agent-schema-inspection.worker.ts",
      "src/state/openclaw-agent-schema-inspection.ts",
    ],
  },
  {
    testFile: "src/state/openclaw-database-preflight.artifacts.test.ts",
    watchGlobs: [
      "src/state/openclaw-agent-schema-inspection.worker.ts",
      "src/state/openclaw-agent-schema-inspection.ts",
      "src/infra/sqlite-readonly-location.worker.ts",
      "src/infra/sqlite-source-revision.worker.ts",
    ],
  },
  {
    testFile: "src/transcripts/store.test.ts",
    watchGlobs: [
      "src/transcripts/store-worker-read.ts",
      "src/transcripts/store-worker-write.ts",
      "src/transcripts/store-sqlite-read.ts",
      "src/transcripts/store-sqlite-write.ts",
      "src/state/openclaw-state.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/infra/sqlite-store.worker.ts",
    ],
  },
  {
    testFile: "test/scripts/docker-build-helper.test.ts",
    watchGlobs: [
      "scripts/docker/sandbox/Dockerfile.browser",
      "scripts/docker/setup.sh",
      "scripts/e2e/agents-delete-shared-workspace-docker.sh",
      "scripts/e2e/kitchen-sink-rpc-walk.mts",
      "scripts/e2e/lib/bundled-plugin-install-uninstall/probe.mjs",
      "scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs",
      "scripts/e2e/lib/bundled-plugin-install-uninstall/sweep.sh",
      "scripts/e2e/lib/codex-media-path/scenario.sh",
      "scripts/e2e/lib/fixtures/mock-openai-config.mjs",
      "scripts/e2e/lib/kitchen-sink-plugin/assertions.mjs",
      "scripts/e2e/lib/kitchen-sink-plugin/sweep.sh",
      "scripts/e2e/lib/npm-onboard-channel-agent/assertions.mjs",
      "scripts/e2e/lib/openai-chat-tools/client.mjs",
      "scripts/e2e/lib/openai-chat-tools/scenario.sh",
      "scripts/e2e/lib/openai-chat-tools/write-config.mjs",
      "scripts/e2e/lib/openai-web-search-minimal/client.mjs",
      "scripts/e2e/lib/openai-web-search-minimal/scenario.sh",
      "scripts/e2e/lib/plugin-update/corrupt-update-scenario.sh",
      "scripts/e2e/lib/plugin-update/unchanged-scenario.sh",
      "scripts/e2e/lib/plugins/assertions.mjs",
      "scripts/e2e/lib/plugins/clawhub.sh",
      "scripts/e2e/lib/plugins/marketplace.sh",
      "scripts/e2e/lib/plugins/npm-registry-server.mjs",
      "scripts/e2e/lib/plugins/sweep.sh",
      "scripts/e2e/lib/release-media-memory/scenario.sh",
      "scripts/e2e/lib/release-user-journey/scenario.sh",
      "scripts/e2e/lib/temp-state-dir.ts",
      "scripts/e2e/lib/upgrade-survivor/config-parking.mjs",
      "scripts/e2e/lib/upgrade-survivor/run.sh",
      "scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh",
      "scripts/e2e/openai-chat-tools-docker.sh",
      "scripts/e2e/session-runtime-context-docker.sh",
      "scripts/lib/openclaw-e2e-instance.sh",
      "scripts/lib/openclaw-test-state.mts",
      "scripts/test-install-sh-docker.sh",
      "scripts/test-live-acp-bind-docker.sh",
      "scripts/test-live-cli-backend-docker.sh",
      "scripts/test-live-codex-harness-docker.sh",
      "scripts/test-live-models-docker.sh",
    ],
  },
  {
    testFile: "test/scripts/vitest-fork-shutdown.test.ts",
    watchGlobs: [
      "scripts/run-vitest.mjs",
      "test/setup.ts",
      "test/setup.env.ts",
      "test/setup.shared.ts",
    ],
  },
  {
    testFile: "test/telegram-outbound-permanent-rejection-loopback.test.ts",
    watchGlobs: ["src/infra/delivery-queue.worker.ts"],
  },
  {
    testFile: "ui/src/test-helpers/control-ui-e2e-suite.test.ts",
    watchGlobs: [
      "ui/src/e2e/control-ui-e2e-suite.test-support.ts",
      "src/test-utils/openclaw-test-state.ts",
    ],
  },
  ...[
    "test/scripts/write-unified-entry-dts.test.ts",
    "test/scripts/write-plugin-sdk-entry-dts.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: ["scripts/lib/declaration-stage.mts"],
  })),
  {
    testFile: "test/scripts/pr-worktree-containment.test.ts",
    watchGlobs: ["scripts/pr-lib/worktree.sh"],
  },
  {
    testFile: "test/scripts/vitest-worker-artifacts.ci.test.ts",
    watchGlobs: ["scripts/ci-run-node-test-shard.mts"],
  },
  {
    testFile: "test/scripts/pr-closeout-gates.test.ts",
    watchGlobs: ["scripts/pr-lib/gates.sh"],
  },
  {
    testFile: "test/scripts/validate-release-publish-approval.test.ts",
    watchGlobs: ["scripts/lib/release-publish-children.sh"],
  },
  {
    testFile: "test/vitest-ui-e2e-config.test.ts",
    watchGlobs: [
      "test/vitest/vitest.ui-e2e-prebuilt.config.ts",
      "test/vitest/vitest.ui-e2e-prebuilt.global-setup.ts",
    ],
  },
  {
    testFile: "test/scripts/upgrade-survivor-plugin-registry.test.ts",
    watchGlobs: [
      "scripts/e2e/upgrade-survivor-docker.sh",
      "scripts/e2e/lib/upgrade-survivor/run.sh",
    ],
  },
  ...[
    "test/scripts/release-workflow-git-lifecycle.test.ts",
    "test/scripts/openclaw-performance-git-lifecycle.test.ts",
    "test/scripts/plugin-release-git-lifecycle.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: [".github/actions/git-owner/owner.py"],
  })),
  {
    testFile: "test/scripts/pr-worktree-evidence.test.ts",
    watchGlobs: [
      "scripts/pr-lib/worktree.sh",
      "scripts/pr-lib/common.sh",
      "scripts/pr-lib/merge-outcome.sh",
      "scripts/pr-lib/operation-lock.sh",
      "scripts/pr-lib/process-group-runner.mjs",
    ],
  },
  {
    testFile: "test/scripts/upgrade-survivor-baseline-order.test.ts",
    watchGlobs: [
      "scripts/e2e/lib/upgrade-survivor/run.sh",
      "scripts/e2e/lib/upgrade-survivor/assertions.mjs",
      "scripts/e2e/lib/upgrade-survivor/legacy-operator-state.mjs",
      "scripts/lib/openclaw-e2e-instance.sh",
    ],
  },
  {
    testFile: "test/scripts/vitest-worker-shutdown.test.ts",
    watchGlobs: ["scripts/run-vitest.mjs", "scripts/ci-run-node-test-shard.mts"],
  },
  {
    testFile: "test/scripts/render-maturity-docs.test.ts",
    watchGlobs: ["taxonomy.yaml", "qa/maturity-scores.yaml"],
  },
  {
    testFile: "test/scripts/npm-onboard-channel-agent-shell.test.ts",
    watchGlobs: [
      "scripts/e2e/npm-onboard-channel-agent-docker.sh",
      "scripts/e2e/lib/prepublish-plugin-registry.sh",
      "scripts/lib/openclaw-e2e-instance.sh",
    ],
  },
  {
    testFile: "test/test-env.test.ts",
    watchGlobs: ["test/helpers/stage-live-auth-profiles.ts"],
  },
  {
    testFile: "test/scripts/vitest-forks-pool.test.ts",
    watchGlobs: [
      "test/vitest/vitest.forks-pool.ts",
      "test/vitest/vitest.fork-diagnostics.mjs",
      "test/vitest/vitest.infra.config.ts",
    ],
  },
  {
    testFile: "test/scripts/telegram-e2e-userbot-skill.test.ts",
    watchGlobs: [
      ".agents/skills/telegram-e2e-userbot/scripts/followup-drain-control-preload.mjs",
      ".agents/skills/telegram-e2e-userbot/scripts/published-upgrade-artifact.mjs",
      ".agents/skills/telegram-e2e-userbot/scripts/published-upgrade-scenario.mjs",
      ".agents/skills/telegram-e2e-userbot/scripts/qa-credential-lease.mjs",
      ".agents/skills/telegram-e2e-userbot/scripts/run-mock-sut-user-e2e.mjs",
      ".agents/skills/telegram-e2e-userbot/scripts/run-published-upgrade-user-e2e.mjs",
      ".agents/skills/telegram-e2e-userbot/scripts/scenario.mjs",
      ".agents/skills/telegram-e2e-userbot/scripts/telegram-api-ignore-abort-preload.mjs",
      ".agents/skills/telegram-e2e-userbot/scripts/telegram-binding-checkpoint.mjs",
      ".agents/skills/telegram-e2e-userbot/scripts/telegram-binding-forum.py",
      ".agents/skills/telegram-e2e-userbot/scripts/telegram-binding-upgrade-verdict.mjs",
      ".agents/skills/telegram-e2e-userbot/scripts/telegram-run-scope.mjs",
      ".agents/skills/telegram-e2e-userbot/scripts/telegram-test-api-proxy.mjs",
      ".agents/skills/telegram-e2e-userbot/scripts/telegram-test-credential.mjs",
      ".agents/skills/telegram-e2e-userbot/scripts/telegram-test-doctor.mjs",
      ".agents/skills/telegram-e2e-userbot/scripts/telegram-test-group.mjs",
      ".agents/skills/telegram-e2e-userbot/scripts/telegram-test-recover.mjs",
      ".agents/skills/telegram-e2e-userbot/scripts/triage-mock-openai.mjs",
      ".agents/skills/telegram-e2e-userbot/scripts/user-driver.py",
      ".agents/skills/telegram-e2e-userbot/scripts/user-record.py",
    ],
  },
  {
    testFile: "src/gateway/client-callsites.guard.test.ts",
    watchGlobs: ["{src,extensions}/**/!(*.test|*.test-support|*.e2e|*.e2e.test|*.live.test).ts"],
  },
  ...[
    "test/scripts/package-acceptance-workflow.test.ts",
    "test/scripts/upgrade-survivor-missing-load-path.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    watchGlobs: ["scripts/e2e/lib/upgrade-survivor/**"],
  })),
  ...["test/scripts/android-app-i18n.test.ts", "test/scripts/apple-app-i18n.test.ts"].map(
    (testFile): PolicyTestWatch => ({
      // Both suites read this inventory by filename, not through the import graph.
      testFile,
      ownerGlobs: ["apps/.i18n/native-source.json"],
      watchGlobs: ["apps/.i18n/native-source.json"],
    }),
  ),
  {
    testFile: "test/scripts/tsgo-core-test-shards.test.ts",
    watchGlobs: [
      "src/{auto-reply,infra/outbound}/**/*.test.{ts,tsx}",
      "tsconfig.json",
      "test/tsconfig/tsconfig.test.json",
      "test/tsconfig/tsconfig.core.test*.json",
      "test/tsconfig/tsconfig.test.packages.json",
    ],
  },
  {
    testFile: "src/infra/fs-safe-import-boundary.test.ts",
    watchGlobs: ["src/test-utils/**/*.ts"],
  },
  {
    testFile: "test/scripts/test-projects.test.ts",
    watchGlobs: ["test/scripts/**/*.test.ts"],
  },
  {
    testFile: "test/vitest-projects-config.test.ts",
    watchGlobs: ["extensions/codex/src/app-server/**/*.test.ts"],
  },
  ...[
    "test/scripts/pr-worktree-provision.test.ts",
    "test/scripts/eager-import-closure.test.ts",
  ].map((testFile): PolicyTestWatch => ({
    testFile,
    ownerGlobs: ["scripts/pr-lib/wrapper-components.txt"],
    watchGlobs: [
      "scripts/pr",
      "scripts/pr-lib/**",
      ...readFileSync(new URL("../pr-lib/wrapper-components.txt", import.meta.url), "utf8")
        .trim()
        .split("\n"),
    ],
  })),
  {
    testFile: "ui/src/components/web-awesome-migration.node.test.ts",
    watchGlobs: ["ui/src/**/*.ts"],
  },
  {
    testFile: "ui/src/styles/base-theme-tokens.node.test.ts",
    ownerGlobs: ["ui/src/**/*.css", "ui/public/themes/*.css"],
    watchGlobs: ["ui/src/**/*.css", "ui/src/**/*.ts", "ui/public/themes/*.css"],
  },
  {
    testFile: "ui/src/styles/base-theme-contrast.node.test.ts",
    ownerGlobs: ["ui/src/styles/base.css", "ui/public/themes/*.css"],
    watchGlobs: ["ui/src/styles/base.css", "ui/public/themes/*.css"],
  },
  {
    testFile: "ui/src/styles/cursor-policy.node.test.ts",
    ownerGlobs: ["ui/index.html", "ui/src/**/*.css"],
    watchGlobs: ["ui/index.html", "ui/src/**/*.css", "ui/src/**/*.ts"],
  },
  ...[
    "src/cron/service.stream-trigger.test.ts",
    "src/cron/service.stream-validation.test.ts",
    "src/cron/service/timer.timeout-watchdog.test.ts",
  ].map((testFile) => ({
    testFile,
    ownerGlobs: ["src/cron/failure-notification-text.ts"],
    watchGlobs: ["src/cron/failure-notification-text.ts"],
  })),
  {
    // Reads the bundled Anthropic manifest to pin the manifest-free alias table.
    testFile: "src/agents/model-ref-shared.test.ts",
    watchGlobs: ["extensions/anthropic/openclaw.plugin.json"],
  },
  {
    testFile: "src/gateway/gateway-ssh-upload-signal.test.ts",
    watchGlobs: [
      "src/agents/sandbox/remote-shell-transport.ts",
      "src/agents/sandbox/remote-shell-backend.ts",
      "src/agents/sandbox/ssh.ts",
      "src/agents/sandbox/ssh-backend.ts",
    ],
  },
] satisfies readonly PolicyTestWatch[];

const literalPolicyPatterns = new Set(
  policyTestWatches
    .flatMap(({ watchGlobs, ownerGlobs }) => [...watchGlobs, ...(ownerGlobs ?? [])])
    .filter(isPlainRepoRelativePath),
);

function matchesPolicyPattern(changedPath: string, pattern: string, literalPath: boolean) {
  return literalPath && literalPolicyPatterns.has(pattern)
    ? changedPath === pattern
    : matchesGlob(changedPath, pattern);
}

/** Resolve watched tests, optionally restricting to complete owners of the changed input. */
export function resolvePolicyTestTargets(
  changedPaths: readonly string[],
  options: { completeOwnersOnly?: boolean } = {},
): string[] {
  const paths = changedPaths.map((changedPath) => ({
    changedPath,
    literal: isPlainRepoRelativePath(changedPath),
  }));
  return policyTestWatches
    .filter(({ watchGlobs, ownerGlobs }) =>
      paths.some(
        ({ changedPath, literal }) =>
          watchGlobs.some((watchGlob) => matchesPolicyPattern(changedPath, watchGlob, literal)) &&
          (!options.completeOwnersOnly ||
            ownerGlobs?.some((ownerGlob) => matchesPolicyPattern(changedPath, ownerGlob, literal))),
      ),
    )
    .map(({ testFile }) => testFile);
}

/** True when the policy tests are the complete bounded owner for this path. */
export function isPolicyTestOwnedPath(changedPath: string): boolean {
  const literal = isPlainRepoRelativePath(changedPath);
  return policyTestWatches.some(({ ownerGlobs }) =>
    ownerGlobs?.some((ownerGlob) => matchesPolicyPattern(changedPath, ownerGlob, literal)),
  );
}
