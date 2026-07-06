// Real behavior proof: node-host runCommand handles stdout/stderr stream error
// events without crashing the node-host process.
//
// The proof patches child_process.spawn so the child is a real process whose
// stdout/stderr streams emit error events after runCommand attaches listeners.
// With the fix the promise resolves to a failed result; without the stream
// error listeners the unhandled errors would terminate the process.

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
    child.stderr?.emit("error", new Error("stderr read failed"));
  };
  return child;
};

const { testing } = await import(path.join(repoRoot, "src/node-host/invoke.js"));

console.log("=== Proof: node-host runCommand stream error handling ===\n");

try {
  const resultPromise = testing.runCommand(
    [process.execPath, "-e", "setTimeout(() => {}, 1000)"],
    undefined,
    undefined,
    5_000,
  );

  // Wait for listeners to attach, then emit stream errors.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
  emitError?.();

  const result = await resultPromise;
  console.log(`Result: success=${result.success}, error=${result.error}`);
  if (!result.success && result.error?.includes("stdout read failed")) {
    console.log("\nPASS: stream errors were caught and runCommand returned a failed result.");
  } else {
    console.log("\nFAIL: runCommand did not report the stream error.");
    process.exitCode = 1;
  }
} catch (err) {
  console.error("\nFAIL: runCommand rejected with:");
  console.error(err);
  process.exitCode = 1;
} finally {
  childProcess.spawn = originalSpawn;
}
