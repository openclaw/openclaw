#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

const WATCH_SCRIPT = "scripts/watch-node.mjs";
const RUN_SCRIPT = "scripts/run-node.mjs";
const WINDOWS_WATCH_ARGS = ["gateway", "run", "--allow-unconfigured"];
const DEFAULT_WATCH_ARGS = ["gateway", "--force"];

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    child.once("exit", (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
    child.once("error", () => {
      resolve(1);
    });
  });
}

async function main() {
  const passthroughArgs = process.argv.slice(2);
  const isWindows = process.platform === "win32";

  if (isWindows) {
    // Windows developer flow commonly has a scheduled daemon running.
    // Stop it best-effort to avoid port conflicts in watch mode.
    await runNode([RUN_SCRIPT, "gateway", "stop"]);
  }

  const baseArgs = isWindows ? WINDOWS_WATCH_ARGS : DEFAULT_WATCH_ARGS;
  const exitCode = await runNode([WATCH_SCRIPT, ...baseArgs, ...passthroughArgs]);
  process.exit(exitCode);
}

void main();
