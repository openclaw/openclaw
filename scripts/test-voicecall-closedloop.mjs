#!/usr/bin/env node

// Runs the closed-loop voice-call test slice through the repo Vitest wrapper.
import { execFileSync } from "node:child_process";
import { bundledPluginFile } from "./lib/bundled-plugin-paths.mjs";

const testFiles = [
  bundledPluginFile("voice-call", "src/manager.test.ts"),
  bundledPluginFile("voice-call", "src/media-stream.test.ts"),
  "src/plugins/voice-call.plugin.test.ts",
];
const args = ["run", "--config", "vitest.config.ts", ...testFiles, "--maxWorkers=1"];
// The nested runner resets its watchdog on output, so this slice also needs a wall-clock limit.
const totalDeadlineMs = 10 * 60 * 1000;

try {
  execFileSync(process.execPath, ["scripts/run-vitest.mjs", ...args], {
    killSignal: "SIGTERM",
    stdio: "inherit",
    timeout: totalDeadlineMs,
  });
} catch (error) {
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ETIMEDOUT") {
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
