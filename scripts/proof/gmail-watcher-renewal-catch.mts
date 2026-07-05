// Real behavior proof: both gateway and foreground Gmail watcher renewal
// intervals catch a rejecting `startGmailWatch` instead of leaking an unhandled
// rejection. The foreground `openclaw webhooks gmail run` path is the actual
// uncaught-promise site on current main because its local `startGmailWatch`
// helper does not internally catch `runCommandWithTimeout` failures.

import { spawnSync } from "node:child_process";

const testFiles = [
  {
    name: "gateway watcher catches renewal interval errors",
    path: "src/hooks/gmail-watcher.test.ts",
  },
  {
    name: "foreground runGmailService catches renewal interval errors",
    path: "src/hooks/gmail-ops.test.ts",
  },
];

console.log("=== Proof: gmail-watcher renewal interval rejection catch ===\n");

let allPassed = true;
for (const test of testFiles) {
  console.log(`Running regression tests: ${test.name}`);
  const result = spawnSync("node", ["scripts/run-vitest.mjs", test.path], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.stdout) {
    console.log(result.stdout);
  }
  if (result.stderr) {
    console.error(result.stderr);
  }
  if (result.status !== 0) {
    allPassed = false;
  }
  console.log("");
}

if (allPassed) {
  console.log("PASS: both gateway and foreground renewal intervals catch rejections.");
} else {
  console.log("FAIL: one or more regression tests did not pass.");
  process.exitCode = 1;
}
