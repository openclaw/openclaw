// Real behavior proof: `runExecResolver` catches stdout/stderr stream errors
// instead of letting them crash the OpenClaw process during secret resolution.
//
// The regression test mocks `spawn` to emit `error` events on the child's
// stdout and stderr streams and verifies that secret resolution still
// succeeds. Before the fix the unhandled stream error would reject.

import { spawnSync } from "node:child_process";

console.log("=== Proof: secrets resolve stream error catch ===\n");
console.log("Running regression test suite: src/secrets/resolve.test.ts\n");

const result = spawnSync(
  "node",
  ["scripts/run-vitest.mjs", "src/secrets/resolve.test.ts"],
  { cwd: process.cwd(), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
);

if (result.stdout) {
  console.log(result.stdout);
}
if (result.stderr) {
  console.error(result.stderr);
}

if (result.status === 0 && result.error === undefined) {
  console.log("\nPASS: secrets resolve stream errors are caught and ignored.");
} else {
  console.log("\nFAIL: regression test suite did not pass.");
  process.exitCode = 1;
}
