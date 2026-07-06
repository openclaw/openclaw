// Real behavior proof: shell-snapshot runShell handles stdout stream error
// events without crashing the agent.
//
// The proof patches child_process.spawn so the shell child is a real process
// whose stdout stream emits an error event after runShell attaches listeners.
// With the fix the promise resolves to a null-status result; without the stdout
// error listener the unhandled error would terminate the process.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process") as typeof import("node:child_process");
const originalSpawn = childProcess.spawn;

let emitError: (() => void) | null = null;

childProcess.spawn = (...args: Parameters<typeof originalSpawn>) => {
  const child = originalSpawn.apply(childProcess, args);
  emitError = () => {
    child.stdout?.emit("error", new Error("stdout read failed"));
  };
  return child;
};

const { testing } = await import(path.join(repoRoot, "src/agents/shell-snapshot.js"));

console.log("=== Proof: shell-snapshot runShell stdout stream error handling ===\n");

try {
  const resultPromise = testing.runShell({
    shell: "/bin/sh",
    shellArgs: ["-c"],
    command: "sleep 1",
    cwd: "/tmp",
    env: {},
    timeoutMs: 5_000,
  });

  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  emitError?.();

  const result = await resultPromise;
  console.log(`Result: status=${result.status}, stdout=${JSON.stringify(result.stdout)}`);
  if (result.status === null) {
    console.log("\nPASS: stdout stream error was caught and runShell returned a null-status result.");
  } else {
    console.log("\nFAIL: runShell did not treat the stdout error as a failure.");
    process.exitCode = 1;
  }
} catch (err) {
  console.error("\nFAIL: runShell rejected with:");
  console.error(err);
  process.exitCode = 1;
} finally {
  childProcess.spawn = originalSpawn;
}
