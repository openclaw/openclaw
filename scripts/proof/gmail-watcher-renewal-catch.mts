// Real behavior proof: gmail watcher renewal interval catches a rejecting
// startGmailWatch instead of leaking an unhandled rejection.
// Because the watcher relies on module-level subprocess seams, this proof runs
// the focused regression test that exercises the renewal timer with fake timers.

import { spawnSync } from "node:child_process";

const testName = "catches renewal interval errors instead of letting them become unhandled rejections";

console.log("=== Proof: gmail-watcher renewal interval rejection catch ===\n");
console.log(`Running focused regression test: ${testName}\n`);

const result = spawnSync(
  "node",
  ["scripts/run-vitest.mjs", "src/hooks/gmail-watcher.test.ts", "-t", testName],
  { cwd: process.cwd(), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
);

if (result.stdout) {
  console.log(result.stdout);
}
if (result.stderr) {
  console.error(result.stderr);
}

if (result.status === 0) {
  console.log("\nPASS: renewal interval rejection is caught and does not become unhandled.");
} else {
  console.log("\nFAIL: focused regression test did not pass.");
  process.exitCode = 1;
}
