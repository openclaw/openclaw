// Real behavior proof: execFileUtf8Tail handles stdout/stderr stream error
// events without crashing the CLI log tail command.
//
// The proof patches child_process.spawn so the child is a real process whose
// stdout/stderr streams emit error events after execFileUtf8Tail attaches
// listeners. With the fix the promise resolves to a failed result; without the
// stream error listeners the unhandled errors would terminate the process.

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

const { execFileUtf8Tail } = await import(path.join(repoRoot, "src/cli/logs-cli.runtime.js"));

console.log("=== Proof: logs-cli runtime execFileUtf8Tail stream error handling ===\n");

try {
  const resultPromise = execFileUtf8Tail(
    process.execPath,
    ["-e", "setTimeout(() => {}, 1000)"],
    { maxBytes: 1024 },
  );

  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  emitError?.();

  const result = await resultPromise;
  console.log(`Result: code=${result.code}, stderr=${result.stderr}`);
  if (result.code === 1 && result.stderr.includes("stdout read failed")) {
    console.log("\nPASS: stream errors were caught and execFileUtf8Tail returned a failed result.");
  } else {
    console.log("\nFAIL: execFileUtf8Tail did not report the stream error.");
    process.exitCode = 1;
  }
} catch (err) {
  console.error("\nFAIL: execFileUtf8Tail rejected with:");
  console.error(err);
  process.exitCode = 1;
} finally {
  childProcess.spawn = originalSpawn;
}
