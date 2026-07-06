// Real behavior proof: `spawnGogServe` catches stdout/stderr stream errors
// instead of letting them crash the OpenClaw process.
//
// The regression test mocks `spawn` to emit `error` events on the child's
// stdout and stderr streams and verifies that `startGmailWatcher` still
// resolves. Before the fix the unhandled stream error would reject the
// watcher promise.

import { spawnSync } from "node:child_process";

console.log("=== Proof: gmail-watcher stream error catch ===\n");
console.log("Running regression test suite: src/hooks/gmail-watcher.test.ts\n");

const result = spawnSync(
  "node",
  ["scripts/run-vitest.mjs", "src/hooks/gmail-watcher.test.ts"],
  { cwd: process.cwd(), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
);

if (result.stdout) {
  console.log(result.stdout);
}
if (result.stderr) {
  console.error(result.stderr);
}

if (result.status === 0 && result.error === undefined) {
  console.log("\nPASS: gmail-watcher stream errors are caught and logged.");
} else {
  console.log("\nFAIL: regression test suite did not pass.");
  process.exitCode = 1;
}
