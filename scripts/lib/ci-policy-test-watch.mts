import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";

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
    testFile: "src/tasks/task-registry-terminal-notification.test.ts",
    watchGlobs: [
      "src/tasks/task-notification.kernel.ts",
      "src/tasks/task-initial.worker.ts",
      "src/tasks/task-registry.worker.ts",
      "src/state/openclaw-state.worker.ts",
      "src/state/openclaw-state-worker-runtime.ts",
      "src/state/openclaw-state-read.worker.ts",
      "src/infra/sqlite-store.worker.ts",
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
  {
    testFile: "src/tasks/task-boundaries.test.ts",
    watchGlobs: ["src/**/!(*.test|*.test-harness|*.test-utils|*.e2e-harness).ts"],
  },
] satisfies readonly PolicyTestWatch[];

/** Resolve watched tests, optionally restricting to complete owners of the changed input. */
export function resolvePolicyTestTargets(
  changedPaths: readonly string[],
  options: { completeOwnersOnly?: boolean } = {},
): string[] {
  return policyTestWatches
    .filter(({ watchGlobs, ownerGlobs }) =>
      changedPaths.some(
        (changedPath) =>
          watchGlobs.some((watchGlob) => matchesGlob(changedPath, watchGlob)) &&
          (!options.completeOwnersOnly ||
            ownerGlobs?.some((ownerGlob) => matchesGlob(changedPath, ownerGlob))),
      ),
    )
    .map(({ testFile }) => testFile);
}

/** True when the policy tests are the complete bounded owner for this path. */
export function isPolicyTestOwnedPath(changedPath: string): boolean {
  return policyTestWatches.some(({ ownerGlobs }) =>
    ownerGlobs?.some((ownerGlob) => matchesGlob(changedPath, ownerGlob)),
  );
}
