// Real behavior proof: `execDockerRaw` handles a stdin stream error without
// crashing and terminates the Docker child.
//
// The proof patches `child_process.spawn` so the `docker` child is replaced
// by a long-lived Node process. After `execDockerRaw` attaches its stdin
// error listener, an error is emitted on `child.stdin`. With the fix the
// function rejects with the stream error and the child is killed; without
// the stdin error listener the unhandled error would terminate the process.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process") as typeof import("node:child_process");
const originalSpawn = childProcess.spawn;

let killed = false;

childProcess.spawn = (...args: Parameters<typeof originalSpawn>) => {
  const cmd = path.basename(args[0] ?? "");
  if (cmd !== "docker") {
    return originalSpawn.apply(childProcess, args);
  }

  const child = originalSpawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"]);
  const originalKill = child.kill.bind(child);
  child.kill = (signal?: string) => {
    killed = true;
    return originalKill(signal);
  };

  setTimeout(() => {
    child.stdin?.emit("error", new Error("stdin write failed"));
  }, 50);

  return child;
};

const { execDockerRaw } = await import(path.join(repoRoot, "src/agents/sandbox/docker.js"));

console.log("=== Proof: docker stdin stream error catch ===\n");

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
process.on("unhandledRejection", onUnhandled);

try {
  await execDockerRaw(["version"], { input: "hello" });
  console.log("FAIL: execDockerRaw should have rejected");
  process.exitCode = 1;
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.log(`Rejected as expected: ${message}`);
  if (message.includes("stdin write failed") && killed && unhandled.length === 0) {
    console.log("\nPASS: execDockerRaw caught the stdin error and killed the child.");
  } else {
    console.log("\nFAIL: unexpected rejection, child not killed, or unhandled rejection.");
    process.exitCode = 1;
  }
} finally {
  process.off("unhandledRejection", onUnhandled);
}
