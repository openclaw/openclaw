import { stateStartupCorpusTestFiles } from "../../test/vitest/vitest.startup-corpus-paths.mjs";

// Complete process/lifecycle proofs stay outside PR CI. Main retains runtime
// owners; manual/release validation also retains the tooling owner.
// Keep this explicit: E2E-named package and browser boundary tests stay on PRs.
export const CI_PROOF_TEST_FILES = [
  "extensions/browser/src/browser/extension-install.native-host.e2e.test.ts",
  "src/gateway/server.codex-failure-recovery.test.ts",
  "test/e2e/qa-lab/plugins/discord-show-widget-contextual-presenter.e2e.test.ts",
  "test/e2e/qa-lab/runtime/sessions-send-visible-child.product-proof.e2e.test.ts",
  "test/scripts/doctor-config-preflight-plugin-index.built-cli.e2e.test.ts",
  "test/scripts/frv.release.test.ts",
  "test/scripts/install-ps1.release.test.ts",
  "test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts",
  "test/scripts/sqlite-sessions-transcripts-flip-proof.e2e.test.ts",
] as const;

const proofTestFiles = new Set<string>(CI_PROOF_TEST_FILES);

export function isCiProofTestFile(file: string): boolean {
  return proofTestFiles.has(file);
}

// Native process and released-state matrices retain their canonical Vitest
// owners, but automatic CI runs them only when the test itself changes.
export const RELEASE_ONLY_RUNTIME_TEST_FILES = [
  "src/agents/harness/acp-native-execution.process.test.ts",
  "src/agents/worktrees/service.exact-state-races.test.ts",
  "src/commands/doctor-config-preflight.process.test.ts",
  "src/commands/doctor-config-preflight.refusal.process.test.ts",
  "src/commands/doctor-plugin-install-config.process.test.ts",
  "src/commands/doctor-session-sqlite.memory.test.ts",
  "src/flows/doctor-health.test.ts",
  "src/gateway/server.sessions.archive-worktree-lifecycle.test.ts",
  "src/gateway/server.sessions.delete-worktree-lifecycle.test.ts",
  "src/infra/update-managed-service-handoff-foreground.test.ts",
  "src/infra/update-managed-service-handoff-native-lifecycle.test.ts",
  "src/infra/update-managed-service-handoff-recovery-launchd.test.ts",
  "src/infra/update-managed-service-handoff-recovery-systemd.test.ts",
  "src/node-host/node-worker-supervisor.recovery.test.ts",
  "src/process/supervisor/adapters/child.service-lifecycle.test.ts",
  "src/state/openclaw-database-preflight.lifecycle.test.ts",
  "test/scripts/ci-linux-git.test.ts",
  "test/scripts/pr-merge-admission.test.ts",
  "test/scripts/pr-merge-outcome.test.ts",
  "test/scripts/pr-merge-rest.test.ts",
  "test/scripts/pr-worktree-provision.test.ts",
  ...stateStartupCorpusTestFiles,
] as const;

const releaseOnlyRuntimeTestFiles = new Set<string>(RELEASE_ONLY_RUNTIME_TEST_FILES);

export function isReleaseOnlyRuntimeTestFile(file: string): boolean {
  return releaseOnlyRuntimeTestFiles.has(file);
}
