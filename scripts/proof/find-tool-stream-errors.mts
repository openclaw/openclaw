// Real behavior proof: the find tool handles stdout/stderr stream error
// events without crashing the agent, and terminates the child process.
//
// The proof places a fake `fd` on PATH so `ensureTool` picks it up, then
// patches `child_process.spawn` so the child's stdout/stderr streams emit
// `error` events after the tool's listeners are attached. With the fix the
// tool rejects cleanly and the child is killed; without the stream error
// listeners the unhandled errors would terminate the process.

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process") as typeof import("node:child_process");
const originalSpawn = childProcess.spawn;

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-proof-find-"));
const fakeFd = path.join(tmpDir, "fd");

// Fake fd that passes --version and then waits, so the stream errors fire
// before the child exits.
await fs.writeFile(
  fakeFd,
  `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "fd 10.0.0"
  exit 0
fi
sleep 2
`,
  "utf8",
);
await fs.chmod(fakeFd, 0o755);

// Prepend the fake fd directory to PATH so ensureTool finds it.
process.env.PATH = `${tmpDir}${path.delimiter}${process.env.PATH ?? ""}`;

let spawnedChild: { killed: boolean } | undefined;

childProcess.spawn = (...args: Parameters<typeof originalSpawn>) => {
  const child = originalSpawn.apply(childProcess, args);
  const cmd = args[0] ?? "";
  if (cmd === fakeFd || path.basename(cmd) === "fd") {
    spawnedChild = child;
    setTimeout(() => {
      child.stdout?.emit("error", new Error("stdout read failed"));
      child.stderr?.emit("error", new Error("stderr read failed"));
    }, 10);
  }
  return child;
};

const { createFindToolDefinition } = await import(
  path.join(repoRoot, "src/agents/sessions/tools/find.js")
);

console.log("=== Proof: find tool stream error catch ===\n");

const tool = createFindToolDefinition(tmpDir);
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
process.on("unhandledRejection", onUnhandled);

try {
  const result = tool.execute("call-1", { pattern: "*.txt" }, undefined, undefined, {} as never);

  try {
    await result;
    console.log("FAIL: execute should have rejected");
    process.exitCode = 1;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`Rejected as expected: ${msg}`);
    if (
      (msg.includes("stdout read failed") || msg.includes("stderr read failed")) &&
      unhandled.length === 0 &&
      spawnedChild?.killed
    ) {
      console.log("\nPASS: find tool caught stream errors and killed the child process.");
    } else {
      console.log("\nFAIL: unexpected rejection message, unhandled rejection, or child not killed.");
      process.exitCode = 1;
    }
  }
} finally {
  process.off("unhandledRejection", onUnhandled);
  await fs.rm(tmpDir, { recursive: true, force: true });
}
