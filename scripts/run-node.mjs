#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

const args = process.argv.slice(2);
const env = { ...process.env };
const cwd = process.cwd();

const build = spawn("pnpm", ["exec", "tsc", "-p", "tsconfig.json"], {
  cwd,
  env,
  stdio: "inherit",
});

build.on("exit", (code, signal) => {
  if (signal) {
    process.exit(1);
    return;
  }
  if (code !== 0 && code !== null) {
    process.exit(code);
    return;
  }

  const nodeProcess = spawn(process.execPath, ["dist/entry.js", ...args], {
    cwd,
    env,
    stdio: "inherit",
  });

  nodeProcess.on("exit", (exitCode, exitSignal) => {
    if (exitSignal) {
      process.exit(1);
      return;
    }
    process.exit(exitCode ?? 1);
  });
});
