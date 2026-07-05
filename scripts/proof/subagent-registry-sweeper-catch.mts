// Real behavior proof: the subagent registry sweeper catches internal errors
// instead of leaking them as unhandled rejections from the periodic interval.
//
// The regression test registers a subagent run, poisons the session store loader,
// and asserts that awaiting the sweep resolves. Before the fix, the sweep rejects
// and would become an unhandled rejection in the production interval.

import { spawnSync } from "node:child_process";

const testName = "catches and logs sweep errors instead of leaking unhandled rejections";

console.log("=== Proof: subagent-registry sweeper rejection catch ===\n");
console.log(`Running focused regression test: ${testName}\n`);

const result = spawnSync(
  "node",
  ["scripts/run-vitest.mjs", "src/agents/subagent-registry.test.ts", "-t", testName],
  { cwd: process.cwd(), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
);

if (result.stdout) {
  console.log(result.stdout);
}
if (result.stderr) {
  console.error(result.stderr);
}

if (result.status === 0) {
  console.log("\nPASS: subagent sweep error is caught and does not leak.");
} else {
  console.log("\nFAIL: focused regression test did not pass.");
  process.exitCode = 1;
}
