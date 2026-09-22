// Complete process/lifecycle proofs run on main and release verification.
// Keep this explicit: E2E-named package and browser boundary tests stay on PRs.
export const CI_PROOF_TEST_FILES = [
  "extensions/browser/src/browser/extension-install.native-host.e2e.test.ts",
  "src/commands/doctor-config-preflight.refusal.process.test.ts",
  "src/gateway/server.codex-failure-recovery.test.ts",
  "test/e2e/qa-lab/plugins/discord-show-widget-contextual-presenter.e2e.test.ts",
  "test/e2e/qa-lab/runtime/sessions-send-visible-child.product-proof.e2e.test.ts",
  "test/scripts/doctor-config-preflight-plugin-index.built-cli.e2e.test.ts",
  "test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts",
  "test/scripts/sqlite-sessions-transcripts-flip-proof.e2e.test.ts",
] as const;

const proofTestFiles = new Set<string>(CI_PROOF_TEST_FILES);

export function isCiProofTestFile(file: string): boolean {
  return proofTestFiles.has(file);
}
