import { buildVitestRunPlans } from "../test-projects.test-support.mts";
import { resolveVitestPretestBuildMode } from "./vitest-build-prerequisites.mts";

export type WindowsTestShard = {
  check_name: string;
  targets: string[];
  predicted_seconds: number;
};

// Run 35530187452, Windows jobs 106129453146/106129453046/106129453011/
// 106129453124/106129453082: elapsed whole-file segments, including imports
// and hooks, rounded up to 0.1s. Concurrent case sums overcount fixture walls.
// Project startup belongs to its first file; keep compatible project files
// together. Timings guide placement; package scripts alone own coverage.
const fileSeconds: Readonly<Record<string, number>> = {
  "extensions/acpx/src/runtime-argv.process.test.ts": 16.2,
  "extensions/canvas/scripts/pnpm-runner.test.ts": 1.5,
  "extensions/lobster/src/lobster-runner.test.ts": 6.4,
  "extensions/memory-core/src/memory-extra-file-path.windows.test.ts": 11,
  "extensions/memory-wiki/src/obsidian.discovery.test.ts": 1.6,
  "extensions/msteams/src/media-helpers.test.ts": 9.8,
  "extensions/msteams/src/messenger.test.ts": 12.2,
  "extensions/mxc/test/fs-bridge.test.ts": 17.3,
  "extensions/mxc/test/mxc-backend.test.ts": 8.1,
  "extensions/mxc/test/path-comparison.test.ts": 1.6,
  "extensions/mxc/test/sandbox-policy-loader.test.ts": 0.1,
  "packages/terminal-core/src/display-string.test.ts": 0.1,
  "src/agents/agent-tools.read.host-operations.test.ts": 6.2,
  "src/agents/agent-tools.read.windows.test.ts": 18.2,
  "src/agents/apply-patch.test.ts": 3.9,
  "src/agents/bash-tools.exec.script-preflight.test.ts": 12.2,
  "src/agents/cli-executable-identity.test.ts": 4.3,
  "src/agents/mcp-stdio-transport.windows.test.ts": 0.4,
  "src/agents/provider-local-service.env-case.test.ts": 4.3,
  "src/agents/sandbox/fs-paths.test.ts": 1.8,
  "src/agents/sessions/exec.real.test.ts": 6.3,
  "src/agents/sessions/tools/path-utils.test.ts": 1.9,
  "src/agents/sessions/tools/render-utils.test.ts": 6.2,
  "src/agents/sessions/windows-git-bash-path.test.ts": 4.1,
  "src/agents/tools/media-tool-file-url.windows.test.ts": 17.8,
  "src/agents/worktrees/filesystem-refs.test.ts": 1.2,
  "src/agents/worktrees/git.test.ts": 6.2,
  "src/auto-reply/reply.triggers.trigger-handling.stages-inbound-media-into-sandbox-workspace.test.ts": 7,
  "src/auto-reply/usage-bar/template.windows.test.ts": 4.8,
  "src/cli/completion-runtime.windows.test.ts": 3.2,
  "src/cli/daemon-cli/status.print.test.ts": 4.2,
  "src/cli/mcp-cli.path-case.windows.test.ts": 6.8,
  "src/cli/runtime-cleanup-scope.windows.process.test.ts": 4,
  "src/commands/agents.commands.list.test.ts": 5.6,
  "src/commands/backup-verify.test.ts": 9.6,
  "src/commands/doctor-gateway-auth-token.windows.test.ts": 0.1,
  "src/commands/doctor-lint.state-isolation.test.ts": 42.8,
  "src/config/io.write-effects.windows.test.ts": 5.8,
  "src/config/sessions/session-accessor.sqlite-archive.worker.test.ts": 26.3,
  "src/daemon/schtasks-state-probe.windows.test.ts": 0.9,
  "src/daemon/schtasks.env-case.real.test.ts": 8.9,
  "src/daemon/schtasks.startup-fallback.test.ts": 8.3,
  "src/flows/doctor-health-contributions.windows-cloud-state.test.ts": 13.1,
  "src/gateway/control-ui-asset-retention.publication.test.ts": 3.2,
  "src/gateway/gateway-cron-process-identity.windows.test.ts": 15.1,
  "src/gateway/worker-environments/workspace-quiescence.windows.test.ts": 4.2,
  "src/gateway/worker-environments/workspace-result-ref-mutation.test.ts": 15,
  "src/infra/advertised-lan-host.windows.test.ts": 0.8,
  "src/infra/diagnostic-process-siblings.env.test.ts": 1.5,
  "src/infra/exec-allowlist-pattern.test.ts": 1.1,
  "src/infra/executable-path.test.ts": 2.2,
  "src/infra/fs-safe-remove.test.ts": 1.3,
  "src/infra/fs-safe.test.ts": 2.5,
  "src/infra/git-exec.test.ts": 1.8,
  "src/infra/openclaw-cli-shim.windows.test.ts": 1.8,
  "src/infra/ports.test.ts": 3.2,
  "src/infra/process-env.test.ts": 0.1,
  "src/infra/sqlite-private-directory.windows.test.ts": 1.3,
  "src/infra/sqlite-snapshot-staging.cancellation.test.ts": 7.4,
  "src/infra/sqlite-snapshot.test.ts": 9.7,
  "src/infra/ssh-client.windows.test.ts": 0.4,
  "src/infra/state-migrations.audit-logs.windows.test.ts": 1.6,
  "src/infra/state-migrations.legacy-session-store.test.ts": 3.9,
  "src/infra/update-candidate-state.budget.test.ts": 16.5,
  "src/infra/update-candidate-state.cleanup.test.ts": 23.2,
  "src/infra/update-candidate-state.namespaced-paths.test.ts": 11.3,
  "src/infra/update-candidate-state.online-backup.process.test.ts": 4,
  "src/infra/update-managed-service-handoff-command.test.ts": 3.3,
  "src/infra/update-managed-service-handoff-database-publication.test.ts": 8.1,
  "src/infra/update-managed-service-handoff-lifecycle.test.ts": 1.8,
  "src/infra/windows-diagnostic-env.test.ts": 1.8,
  "src/infra/windows-encoding.test.ts": 0.7,
  "src/infra/windows-install-roots.test.ts": 0.6,
  "src/infra/windows-process-start.native.test.ts": 0.7,
  "src/infra/windows-process-start.test.ts": 0.9,
  "src/media-understanding/attachments.file-url.windows.test.ts": 3.8,
  "src/media/local-media-path.windows.test.ts": 15.6,
  "src/media/web-media.file-url.windows.test.ts": 4.1,
  "src/node-host/invoke-agent-cli-claude.test.ts": 14.7,
  "src/node-host/invoke-system-run-allowlist.test.ts": 4.8,
  "src/node-host/node-worker-bundle-installer.test.ts": 1.6,
  "src/node-host/node-worker-transfer-client.test.ts": 5.6,
  "src/plugin-sdk/fs-safe-compat.test.ts": 6.1,
  "src/plugin-sdk/node-host.test.ts": 2,
  "src/plugin-sdk/windows-spawn.test.ts": 1.8,
  "src/process/exec.windows.integration.test.ts": 155.8,
  "src/process/exec.windows.test.ts": 2.6,
  "src/process/owned-stdio.real.test.ts": 2.4,
  "src/process/owned-stdio.windows.test.ts": 4.3,
  "src/process/supervisor/supervisor.anchored-shell.real.test.ts": 5.7,
  "src/process/terminal-pty.test.ts": 1.4,
  "src/process/windows-command.test.ts": 6.5,
  "src/shared/pid-alive.env.test.ts": 1.4,
  "src/shared/runtime-import.test.ts": 1.4,
  "src/shared/worker-bundle-archive.test.ts": 4,
  "src/skills/runtime/refresh-watch-close.test.ts": 0.1,
  "src/skills/runtime/refresh-watch-path.test.ts": 0.2,
  "src/skills/runtime/refresh.missing-root.integration.test.ts": 5.4,
  "src/skills/runtime/refresh.windows.test.ts": 0.3,
  "src/snapshot/local-repository.windows.test.ts": 3.7,
  "src/state/openclaw-database-paths.windows.test.ts": 8.8,
  "src/state/openclaw-state-ownership.test.ts": 12.9,
  "src/test-utils/openclaw-test-state.test.ts": 10.5,
  "src/tui/tui.resolve-codex-bin.test.ts": 10.3,
  "src/utils.test.ts": 1.3,
  "test/e2e/qa-lab/runtime/package-openclaw-for-docker.e2e.test.ts": 21,
  "test/helpers/openclaw-test-instance.test.ts": 31.1,
  "test/helpers/temp-dir.test.ts": 2.2,
  "test/scripts/check-openclaw-package-tarball.test.ts": 54.8,
  "test/scripts/ci-platform-checkout.test.ts": 30.7,
  "test/scripts/direct-run-entrypoints.test.ts": 17.4,
  "test/scripts/format-generated-module.test.ts": 0.1,
  "test/scripts/install-ps1.test.ts": 46.3,
  "test/scripts/managed-child-process.output.test.ts": 2.7,
  "test/scripts/managed-child-process.windows.test.ts": 1.4,
  "test/scripts/managed-windows-job.test.ts": 0.1,
  "test/scripts/npm-runner.test.ts": 0.1,
  "test/scripts/openclaw-cross-os-installer.windows.test.ts": 2.1,
  "test/scripts/openclaw-cross-os-release-workflow.test.ts": 1.6,
  "test/scripts/pnpm-runner.test.ts": 1.5,
  "test/scripts/run-with-env.test.ts": 0.4,
  "test/scripts/ts-topology.test.ts": 3.1,
  "test/scripts/tsdown-declaration-resolution.test.ts": 86.5,
  "test/scripts/ui.test.ts": 3.5,
  "test/scripts/vitest-process-cache.test.ts": 0.5,
  "test/scripts/vitest-process-group.test.ts": 2.1,
  "test/scripts/vitest-worker-artifacts.test.ts": 170.3,
  "test/scripts/vitest-worker-artifacts.transforms.test.ts": 8.8,
  "test/scripts/worker-deploy-build-plugin.test.ts": 49.5,
  "test/scripts/write-plugin-sdk-entry-dts.test.ts": 74.3,
  "test/scripts/write-unified-entry-dts.test.ts": 66.8,
};

// Hosted PR run 36255492762: serial whole-file spans include project startup,
// imports, hooks, and teardown. Shared worker preparation is charged once below;
// preparations performed inside test fixtures remain part of their file cost.
const hostedPullRequestFileSeconds: Readonly<Record<string, number>> = {
  "extensions/acpx/src/runtime-argv.process.test.ts": 40.7,
  "extensions/canvas/scripts/pnpm-runner.test.ts": 0.8,
  "extensions/lobster/src/lobster-runner.test.ts": 22.5,
  "extensions/memory-core/src/memory-extra-file-path.windows.test.ts": 14.5,
  "extensions/memory-wiki/src/obsidian.discovery.test.ts": 2.5,
  "extensions/msteams/src/media-helpers.test.ts": 2,
  "extensions/msteams/src/messenger.test.ts": 10.4,
  "extensions/mxc/test/fs-bridge.test.ts": 29,
  "extensions/mxc/test/mxc-backend.test.ts": 23.6,
  "extensions/mxc/test/path-comparison.test.ts": 5.1,
  "extensions/mxc/test/sandbox-policy-loader.test.ts": 0.2,
  "packages/terminal-core/src/display-string.test.ts": 0.1,
  "src/agents/agent-tools.read.host-operations.test.ts": 1.6,
  "src/agents/agent-tools.read.windows.test.ts": 19.5,
  "src/agents/apply-patch.test.ts": 11,
  "src/agents/bash-tools.exec.script-preflight.test.ts": 22.8,
  "src/agents/cli-executable-identity.test.ts": 3.5,
  "src/agents/mcp-stdio-transport.windows.test.ts": 0.6,
  "src/agents/provider-local-service.env-case.test.ts": 2.5,
  "src/agents/provider-local-service.settlement.test.ts": 0.1,
  "src/agents/provider-local-service.shutdown.test.ts": 14.1,
  "src/agents/sandbox/fs-paths.test.ts": 0.3,
  "src/agents/sessions/exec.real.test.ts": 6.3,
  "src/agents/sessions/tools/path-utils.test.ts": 0.2,
  "src/agents/sessions/tools/render-utils.test.ts": 0.5,
  "src/agents/sessions/windows-git-bash-path.test.ts": 10.7,
  "src/agents/tools/media-tool-file-url.windows.test.ts": 53,
  "src/agents/worktrees/filesystem-refs.test.ts": 0.3,
  "src/agents/worktrees/git.test.ts": 23.9,
  "src/agents/worktrees/service.removal-recovery.windows.test.ts": 61.5,
  "src/auto-reply/reply.triggers.trigger-handling.stages-inbound-media-into-sandbox-workspace.test.ts": 22.5,
  "src/auto-reply/usage-bar/template.windows.test.ts": 0.4,
  "src/cli/completion-runtime.windows.test.ts": 2.5,
  "src/cli/daemon-cli/status.print.test.ts": 9.3,
  "src/cli/mcp-cli.path-case.windows.test.ts": 4,
  "src/cli/runtime-cleanup-scope.windows.process.test.ts": 5.4,
  "src/cli/update-cli/update-command-migrated-windows.test.ts": 12.6,
  "src/cli/update-cli/update-command-readiness.windows.test.ts": 21.2,
  "src/commands/agents.commands.list.test.ts": 1,
  "src/commands/backup-verify.test.ts": 39.8,
  "src/commands/doctor-config-preflight.state-migration.test.ts": 1.2,
  "src/commands/doctor-gateway-auth-token.windows.test.ts": 0.3,
  "src/commands/doctor-lint.state-isolation.test.ts": 195.5,
  "src/config/io.snapshot.test.ts": 4.4,
  "src/config/io.write-effects.windows.test.ts": 13.3,
  "src/config/sessions/session-accessor.sqlite-archive.worker.test.ts": 83.3,
  "src/daemon/schtasks-runtime-probe.windows.test.ts": 0.2,
  "src/daemon/schtasks-state-probe.windows.test.ts": 1.9,
  "src/daemon/schtasks.env-case.real.test.ts": 5.2,
  "src/daemon/schtasks.startup-fallback.test.ts": 14.9,
  "src/daemon/service-audit-schtasks.windows.test.ts": 3.7,
  "src/flows/doctor-health-contributions.windows-cloud-state.test.ts": 15.9,
  "src/gateway/control-ui-asset-retention.publication.test.ts": 4.4,
  "src/gateway/gateway-cron-process-identity.windows.test.ts": 41.8,
  "src/gateway/worker-environments/workspace-quiescence.windows.test.ts": 2.7,
  "src/gateway/worker-environments/workspace-result-ref-mutation.test.ts": 17.8,
  "src/infra/advertised-lan-host.windows.test.ts": 1.1,
  "src/infra/diagnostic-process-siblings.env.test.ts": 1.7,
  "src/infra/exec-allowlist-pattern.test.ts": 0.1,
  "src/infra/executable-path.test.ts": 1.7,
  "src/infra/fs-safe-pinned-write-errno.test.ts": 0.1,
  "src/infra/fs-safe-remove.test.ts": 1.5,
  "src/infra/fs-safe.test.ts": 1.1,
  "src/infra/git-exec.test.ts": 2.3,
  "src/infra/openclaw-cli-shim.windows.test.ts": 2.2,
  "src/infra/ports.test.ts": 3.1,
  "src/infra/process-env.test.ts": 0.1,
  "src/infra/sqlite-private-directory.windows.test.ts": 2.4,
  "src/infra/sqlite-snapshot-retirement.test.ts": 2.2,
  "src/infra/sqlite-snapshot-staging.cancellation.test.ts": 10.6,
  "src/infra/sqlite-snapshot.test.ts": 4.1,
  "src/infra/ssh-client.windows.test.ts": 0.2,
  "src/infra/state-migrations.audit-logs.windows.test.ts": 2.5,
  "src/infra/state-migrations.legacy-session-store.test.ts": 2.6,
  "src/infra/state-migrations.workspace-setup.windows.test.ts": 1.9,
  "src/infra/update-candidate-canary.cleanup.test.ts": 21.4,
  "src/infra/update-candidate-state.budget.test.ts": 16.8,
  "src/infra/update-candidate-state.cleanup.test.ts": 23.1,
  "src/infra/update-candidate-state.namespaced-paths.test.ts": 12.3,
  "src/infra/update-candidate-state.online-backup.process.test.ts": 7.5,
  "src/infra/update-managed-service-handoff-command.test.ts": 4.2,
  "src/infra/update-managed-service-handoff-database-publication.test.ts": 3.7,
  "src/infra/update-managed-service-handoff-lifecycle.test.ts": 14.9,
  "src/infra/windows-diagnostic-env.test.ts": 2.4,
  "src/infra/windows-encoding.test.ts": 0.9,
  "src/infra/windows-install-roots.test.ts": 0.8,
  "src/infra/windows-process-start.native.test.ts": 1,
  "src/infra/windows-process-start.test.ts": 1.1,
  "src/media-understanding/attachments.file-url.windows.test.ts": 5,
  "src/media/local-media-path.windows.test.ts": 29.5,
  "src/media/web-media.file-url.windows.test.ts": 0.4,
  "src/node-host/invoke-agent-cli-claude.test.ts": 7.9,
  "src/node-host/invoke-system-run-allowlist.test.ts": 0.4,
  "src/node-host/node-worker-bundle-installer.test.ts": 1.8,
  "src/node-host/node-worker-transfer-client.test.ts": 2.9,
  "src/plugin-sdk/fs-safe-compat.test.ts": 5.9,
  "src/plugin-sdk/node-host.test.ts": 0.5,
  "src/plugin-sdk/windows-spawn.test.ts": 4,
  "src/process/exec.windows.integration.test.ts": 152.9,
  "src/process/exec.windows.test.ts": 3.6,
  "src/process/owned-stdio.real.test.ts": 5.6,
  "src/process/owned-stdio.windows.test.ts": 1.1,
  "src/process/supervisor/supervisor.anchored-shell.real.test.ts": 2.4,
  "src/process/terminal-pty.test.ts": 0.1,
  "src/process/windows-command.test.ts": 6.9,
  "src/shared/pid-alive.env.test.ts": 0.3,
  "src/shared/runtime-import.test.ts": 0.1,
  "src/shared/worker-bundle-archive.test.ts": 9,
  "src/skills/runtime/refresh-ancestor-native.test.ts": 0.8,
  "src/skills/runtime/refresh-content-native.entries.test.ts": 1.3,
  "src/skills/runtime/refresh-content-native.test.ts": 2.2,
  "src/skills/runtime/refresh-watch-close.test.ts": 0.1,
  "src/skills/runtime/refresh-watch-path.test.ts": 0.1,
  "src/skills/runtime/refresh.missing-root.integration.test.ts": 19.5,
  "src/skills/runtime/refresh.symbolic-source.integration.test.ts": 5,
  "src/skills/runtime/refresh.windows.test.ts": 0.2,
  "src/snapshot/local-repository.windows.test.ts": 1,
  "src/state/openclaw-database-paths.windows.test.ts": 12.8,
  "src/state/openclaw-state-ownership.test.ts": 38.7,
  "src/test-utils/openclaw-test-state.test.ts": 42.2,
  "src/tui/tui.resolve-codex-bin.test.ts": 26,
  "src/utils.test.ts": 3.6,
  "test/e2e/qa-lab/runtime/package-openclaw-for-docker.e2e.test.ts": 44,
  "test/helpers/openclaw-test-instance.test.ts": 31.3,
  "test/helpers/temp-dir.test.ts": 0.1,
  "test/scripts/check-openclaw-package-tarball.bundled-mcp.test.ts": 159.6,
  "test/scripts/check-openclaw-package-tarball.test.ts": 37.7,
  "test/scripts/ci-platform-checkout.test.ts": 43,
  "test/scripts/direct-run-entrypoints.test.ts": 22.2,
  "test/scripts/format-generated-module.test.ts": 0.1,
  "test/scripts/install-ps1.test.ts": 2.5,
  "test/scripts/managed-child-process.output.test.ts": 2.9,
  "test/scripts/managed-child-process.windows.test.ts": 0.8,
  "test/scripts/managed-windows-job.test.ts": 0.1,
  "test/scripts/npm-runner.test.ts": 0.1,
  "test/scripts/openclaw-cross-os-installer.windows.test.ts": 1.9,
  "test/scripts/openclaw-cross-os-release-workflow.test.ts": 10.7,
  "test/scripts/pnpm-runner.test.ts": 5.1,
  "test/scripts/run-with-env.test.ts": 0.2,
  "test/scripts/ts-topology.test.ts": 4.2,
  "test/scripts/tsdown-declaration-resolution.test.ts": 215,
  "test/scripts/ui.test.ts": 2.1,
  "test/scripts/vitest-process-cache.test.ts": 0.6,
  "test/scripts/vitest-process-group.test.ts": 0.4,
  "test/scripts/vitest-worker-artifacts.test.ts": 258.6,
  "test/scripts/vitest-worker-artifacts.transforms.test.ts": 15.4,
  "test/scripts/windows-blacksmith-testbox.test.ts": 0.9,
  "test/scripts/worker-deploy-build-plugin.test.ts": 96.7,
  "test/scripts/write-plugin-sdk-entry-dts.test.ts": 75.9,
  "test/scripts/write-unified-entry-dts.test.ts": 82.3,
};

// Maximum observed setup (77s), shared worker compilation (21s), and
// wrapper/project transitions (6s). Runtime preparation is charged once below.
const setupSeconds = 104;
const runtimeBuildSeconds = 68;
const fallbackFileSeconds = 3;
const targetSeconds = 420;

function readWindowsTargets(scripts: Readonly<Record<string, string | undefined>>): string[] {
  const targets = [1, 2].flatMap((part) => {
    const script = scripts[`test:windows:ci:${part}`];
    const match = script?.match(/^node --import \S+ scripts\/test-projects\.mts (.+)$/u);
    const files = match?.[1]?.trim().split(/\s+/u);
    if (!files?.length || files.some((file) => !/^[\w./-]+\.test\.tsx?$/u.test(file))) {
      throw new Error(`Windows CI part ${part} must declare explicit test-projects file targets`);
    }
    return files;
  });
  if (new Set(targets).size !== targets.length) {
    throw new Error("Windows CI package scripts must not repeat a test file");
  }
  return targets;
}

export function createWindowsTestShards(
  scripts: Readonly<Record<string, string | undefined>>,
  options: { hostedPullRequest?: boolean } = {},
): WindowsTestShard[] {
  // Hosted setup reached 112s and shared workers 49s; reserve the remaining
  // 39s for wrapper transitions and variation. Runtime build reached 116s.
  const timingProfile = options.hostedPullRequest
    ? {
        fileSeconds: hostedPullRequestFileSeconds,
        setupSeconds: 200,
        runtimeBuildSeconds: 117,
        maxShards: 12,
      }
    : { fileSeconds, setupSeconds, runtimeBuildSeconds, maxShards: 5 };
  const envelopes: { targets: string[]; seconds: number }[] = [];
  const projects = new Map<string, { targets: string[]; seconds: number }>();
  const runtime = { targets: [] as string[], seconds: timingProfile.runtimeBuildSeconds };
  for (const file of readWindowsTargets(scripts).toSorted()) {
    const seconds = timingProfile.fileSeconds[file] ?? fileSeconds[file] ?? fallbackFileSeconds;
    if (resolveVitestPretestBuildMode([{ includePatterns: [file] }]) !== undefined) {
      // test-projects prepares one runtime before all serial project borrowers.
      runtime.targets.push(file);
      runtime.seconds += seconds;
    } else {
      const configs = buildVitestRunPlans([file]).map((plan) => plan.config);
      const key = configs.toSorted().join("\n") || file;
      const project = projects.get(key) ?? { targets: [], seconds: 0 };
      project.targets.push(file);
      project.seconds += seconds;
      projects.set(key, project);
    }
  }
  for (const project of projects.values()) {
    if (Math.ceil(project.seconds + timingProfile.setupSeconds) < targetSeconds) {
      envelopes.push(project);
    } else {
      // A large project (currently tooling) still keeps each fixture file whole.
      envelopes.push(
        ...project.targets.map((file) => ({
          targets: [file],
          seconds: timingProfile.fileSeconds[file] ?? fileSeconds[file] ?? fallbackFileSeconds,
        })),
      );
    }
  }
  if (runtime.targets.length) {
    envelopes.push(runtime);
  }
  envelopes.sort(
    (left, right) =>
      right.seconds - left.seconds || left.targets[0]!.localeCompare(right.targets[0]!, "en"),
  );

  for (let count = 4; count <= timingProfile.maxShards; count += 1) {
    const shards = Array.from({ length: Math.min(count, envelopes.length) }, (_, index) => ({
      check_name: `checks-windows-node-test-${index + 1}`,
      targets: [] as string[],
      predicted_seconds: timingProfile.setupSeconds,
    }));
    for (const envelope of envelopes) {
      const shard = shards.reduce((best, candidate) =>
        candidate.predicted_seconds < best.predicted_seconds ? candidate : best,
      );
      shard.predicted_seconds += envelope.seconds;
      shard.targets.push(...envelope.targets);
    }
    // Keep whole files: splitting a fixture file would repeat its prepared compiler.
    // Growth may exceed the estimate, but never removes coverage or exceeds the profile cap.
    if (
      count === timingProfile.maxShards ||
      shards.every((shard) => Math.ceil(shard.predicted_seconds) < targetSeconds)
    ) {
      return shards.map((shard) => ({
        check_name: shard.check_name,
        predicted_seconds: Math.ceil(shard.predicted_seconds),
        targets: shard.targets.toSorted(),
      }));
    }
  }
  throw new Error("Windows CI shard count is unavailable");
}
