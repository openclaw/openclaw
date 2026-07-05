// Real behavior proof: `refreshRemoteBinsForConnectedNodes` catches per-node
// refresh failures instead of letting the first rejecting node abort the whole
// refresh and leak an unhandled rejection to its caller.
//
// The regression test registers two connected remote nodes, makes the first
// node's connectivity check throw, and asserts that the refresh resolves and
// still probes the second node.

import { spawnSync } from "node:child_process";

console.log("=== Proof: skills-remote refresh rejection catch ===\n");
console.log("Running regression test suite: src/skills/runtime/remote.test.ts\n");

const result = spawnSync(
  "node",
  ["scripts/run-vitest.mjs", "src/skills/runtime/remote.test.ts"],
  { cwd: process.cwd(), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
);

if (result.stdout) {
  console.log(result.stdout);
}
if (result.stderr) {
  console.error(result.stderr);
}

if (result.status === 0) {
  console.log("\nPASS: per-node remote bin refresh errors are caught and the sweep continues.");
} else {
  console.log("\nFAIL: focused regression test did not pass.");
  process.exitCode = 1;
}
