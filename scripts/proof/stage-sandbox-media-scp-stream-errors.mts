// Real behavior proof: stage-sandbox-media scpFile handles stderr stream error
// events without crashing the auto-reply process.
//
// The proof patches child_process.spawn so the scp child is a real process whose
// stderr stream emits an error event after scpFile attaches listeners. With the
// fix the promise rejects with the stream error; without the stderr error
// listener the unhandled error would terminate the process.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process") as typeof import("node:child_process");
const originalSpawn = childProcess.spawn;

let emitError: (() => void) | null = null;
let currentChild: ReturnType<typeof originalSpawn> | null = null;

childProcess.spawn = (...args: Parameters<typeof originalSpawn>) => {
  const child = originalSpawn.apply(childProcess, args);
  currentChild = child;
  emitError = () => {
    child.stderr?.emit("error", new Error("stderr EPIPE"));
  };
  return child;
};

const { scpFile } = await import(path.join(repoRoot, "src/auto-reply/reply/stage-sandbox-media.js"));

console.log("=== Proof: stage-sandbox-media scpFile stderr stream error handling ===\n");

try {
  const resultPromise = scpFile("example.com", "/remote/path", "/tmp/stage-sandbox-media-proof-download");

  // Wait for listeners to attach, then emit a stderr stream error.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
  emitError?.();

  await resultPromise;
  console.log("\nFAIL: scpFile resolved despite the stderr stream error.");
  process.exitCode = 1;
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.log(`Rejected with: ${message}`);
  if (message.includes("stderr EPIPE")) {
    console.log("\nPASS: stderr stream error was caught and scpFile rejected cleanly.");
  } else {
    console.log("\nFAIL: scpFile rejected with an unexpected error.");
    process.exitCode = 1;
  }
} finally {
  childProcess.spawn = originalSpawn;
  currentChild?.kill();
}
