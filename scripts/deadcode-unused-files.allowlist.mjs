// Intentional Knip unused-file findings. These are dynamic entrypoints,
// generated/build inputs, manifest-discovered plugin surfaces, live-test
// helpers, or package bridge files that static production scanning cannot see.
export const KNIP_UNUSED_FILE_ALLOWLIST = [];

// Knip can disagree across supported local/CI platforms for files that are
// only reachable through test-only import graphs. Ignore these when reported,
// but do not require them to be reported.
export const KNIP_OPTIONAL_UNUSED_FILE_ALLOWLIST = [
  "extensions/qa-lab/src/auth-profile.fixture.ts",
  "extensions/qa-lab/src/codex-plugin.fixture.ts",
  "src/gateway/test/server-sessions-helpers.ts",
];
