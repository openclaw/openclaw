// Real behavior proof: `scheduleRestartSentinelWake` catches unexpected errors
// instead of leaking them to its caller.
//
// The regression test poisons `readRestartSentinel` to reject and asserts that
// `scheduleRestartSentinelWake` resolves and logs a warning. Before the fix the
// rejection would propagate out of the wake function.

import { spawnSync } from "node:child_process";

console.log("=== Proof: restart-sentinel wake rejection catch ===\n");
console.log("Running regression test suite: src/gateway/server-restart-sentinel.test.ts\n");

const result = spawnSync(
  "node",
  ["scripts/run-vitest.mjs", "src/gateway/server-restart-sentinel.test.ts"],
  { cwd: process.cwd(), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
);

if (result.stdout) {
  console.log(result.stdout);
}
if (result.stderr) {
  console.error(result.stderr);
}

if (result.status === 0) {
  console.log("\nPASS: restart sentinel wake errors are caught and logged.");
} else {
  console.log("\nFAIL: regression test suite did not pass.");
  process.exitCode = 1;
}
