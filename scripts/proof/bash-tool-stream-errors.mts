// Real behavior proof: local bash operations handle stdout/stderr stream errors
// without crashing the agent runtime.
//
// The proof patches child_process.spawn so the spawned shell is a real process
// whose stdout/stderr streams emit error events after the bash tool attaches
// listeners. With the fix the exec promise rejects with the stream error; without
// stream error handlers the unhandled errors would terminate the process.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process") as typeof import("node:child_process");
const originalSpawn = childProcess.spawn;

let emitError: ((stream: "stdout" | "stderr") => void) | null = null;

childProcess.spawn = (...args: Parameters<typeof originalSpawn>) => {
  const child = originalSpawn.apply(childProcess, args);
  emitError = (stream) => {
    const target = stream === "stdout" ? child.stdout : child.stderr;
    target?.emit("error", new Error(`${stream} EPIPE`));
  };
  return child;
};

const { createLocalBashOperations } = await import(
  path.join(repoRoot, "src/agents/sessions/tools/bash.ts")
);

function longRunningCommand(): string {
  return `${process.execPath} -e "setTimeout(() => {}, 5000)"`;
}

async function runProof(stream: "stdout" | "stderr"): Promise<boolean> {
  const operations = createLocalBashOperations();
  const resultPromise = operations.exec(longRunningCommand(), process.cwd(), {
    onData: () => {},
  });

  // Wait for listeners to attach, then emit the stream error.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 100);
  });
  emitError?.(stream);

  try {
    await resultPromise;
    console.log(`FAIL (${stream}): exec resolved instead of rejecting`);
    return false;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("EPIPE")) {
      console.log(`PASS (${stream}): stream error rejected with "${message}"`);
      return true;
    }
    console.log(`FAIL (${stream}): rejected with unexpected error "${message}"`);
    return false;
  }
}

console.log("=== Proof: bash tool stream error handling ===\n");

let ok = true;
ok = (await runProof("stdout")) && ok;
ok = (await runProof("stderr")) && ok;

childProcess.spawn = originalSpawn;

if (!ok) {
  process.exitCode = 1;
}
