// Real behavior proof: `waitForChildProcess` catches stdout/stderr stream errors
// instead of letting them crash the agent runtime.
//
// The regression test emits `error` events on fake PassThrough stdout/stderr
// streams and verifies that `waitForChildProcess` still resolves with the
// child's exit code. Before the fix the unhandled stream error would reject.

import { spawnSync } from "node:child_process";

console.log("=== Proof: agents child-process stream error catch ===\n");
console.log("Running regression test suite: src/agents/utils/child-process.test.ts\n");

const result = spawnSync(
  "node",
  ["scripts/run-vitest.mjs", "src/agents/utils/child-process.test.ts"],
  { cwd: process.cwd(), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
);

if (result.stdout) {
  console.log(result.stdout);
}
if (result.stderr) {
  console.error(result.stderr);
}

if (result.status === 0 && result.error === undefined) {
  console.log("\nPASS: child-process stream errors are caught and ignored.");
} else {
  console.log("\nFAIL: regression test suite did not pass.");
  process.exitCode = 1;
}
