// Real behavior proof: tool_search_code handles stderr stream errors without crashing.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process") as typeof import("node:child_process");
const originalSpawn = childProcess.spawn;

// Patch spawn so the code-mode child is a real process whose stderr emits an
// error after runCodeModeChild attaches listeners.
childProcess.spawn = (...args: Parameters<typeof originalSpawn>) => {
  const cmd = args[0] ?? "";
  const argv = args[1] as string[] | undefined;
  const isCodeModeChild = cmd === process.execPath && argv?.includes("--eval");

  if (!isCodeModeChild) {
    return originalSpawn.apply(childProcess, args);
  }

  const child = originalSpawn(process.execPath, [
    "-e",
    "setTimeout(() => {}, 5000)",
  ], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  setTimeout(() => {
    child.stderr?.emit("error", new Error("tool_search_code stderr read failed"));
  }, 100);

  return child;
};

const { __testing: testing } = await import(path.join(repoRoot, "src/agents/tool-search.js"));

console.log("=== Proof: tool-search code-mode stderr stream error catch ===\n");

try {
  testing.setToolSearchCodeModeSupportedForTest(true);
  testing.setToolSearchMinCodeTimeoutMsForTest(1000);
  const runtime = new testing.ToolSearchRuntime({}, testing.resolveToolSearchConfig({}));

  await testing.runCodeModeChild({
    code: "return 1;",
    config: testing.resolveToolSearchConfig({}),
    logs: [],
    parentToolCallId: "proof-stderr-error",
    runtime,
  });

  console.log("FAIL: runCodeModeChild resolved unexpectedly.");
  process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("tool_search_code stderr read failed")) {
    console.log("PASS: runCodeModeChild rejected with the stderr error instead of crashing.");
  } else {
    console.error("FAIL: unexpected rejection:", error);
    process.exitCode = 1;
  }
} finally {
  testing.setToolSearchCodeModeSupportedForTest(undefined);
  testing.setToolSearchMinCodeTimeoutMsForTest(undefined);
}
