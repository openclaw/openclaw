#!/usr/bin/env node

// Runs the closed-loop voice-call test slice through the repo Vitest wrapper.
import { bundledPluginFile } from "./lib/bundled-plugin-paths.mjs";
import { MANAGED_COMMAND_TIMEOUT_CODE, runManagedCommand } from "./lib/managed-child-process.mjs";

const testFiles = [
  bundledPluginFile("voice-call", "src/manager.closed-loop.test.ts"),
  bundledPluginFile("voice-call", "src/media-stream.test.ts"),
  bundledPluginFile("voice-call", "index.test.ts"),
];
const args = ["run", "--config", "vitest.config.ts", ...testFiles, "--maxWorkers=1"];
// The nested runner resets its watchdog on output, so this slice also needs a wall-clock limit.
const totalDeadlineMs = 10 * 60 * 1000;

try {
  process.exitCode = await runManagedCommand({
    args: ["scripts/run-vitest.mjs", ...args],
    bin: process.execPath,
    shell: false,
    stdio: "inherit",
    timeoutMs: totalDeadlineMs,
  });
} catch (error) {
  if (
    !error ||
    typeof error !== "object" ||
    !("code" in error) ||
    error.code !== MANAGED_COMMAND_TIMEOUT_CODE
  ) {
    throw error;
  }
  throw new Error(
    [
      `closed-loop voice-call test slice timed out after ${totalDeadlineMs}ms`,
      "Target test files:",
      ...testFiles.map((file) => `  - ${file}`),
    ].join("\n"),
    { cause: error },
  );
}
