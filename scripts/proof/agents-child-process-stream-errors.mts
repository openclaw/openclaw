// Real behavior proof: `waitForChildProcess` handles real stdout/stderr stream
// error events without crashing the agent runtime.
//
// The proof spawns a real child process, calls the production
// `waitForChildProcess` helper, and then emits `error` events on the child's
// stdout and stderr streams (simulating the rare OS-level pipe errors the
// fix is meant to survive). With the fix the promise still resolves with the
// child's exit code; without the error listeners the unhandled stream errors
// would terminate the process.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const { waitForChildProcess } = await import(path.join(repoRoot, "src/agents/utils/child-process.js"));

console.log("=== Proof: agents child-process stream error catch ===\n");

const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(42), 2000)"]);

const promise = waitForChildProcess(child);

// Simulate OS-level stream read errors on the child's stdout/stderr pipes.
child.stdout?.emit("error", new Error("stdout read failed"));
child.stderr?.emit("error", new Error("stderr read failed"));

try {
  const code = await promise;
  if (code === 42) {
    console.log(`Child exited with code ${code}.`);
    console.log("\nPASS: stream errors were caught and waitForChildProcess still resolved.");
  } else {
    console.log(`\nFAIL: unexpected exit code ${code}.`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error("\nFAIL: waitForChildProcess rejected with:");
  console.error(err);
  process.exitCode = 1;
}
