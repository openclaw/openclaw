#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const args = process.argv.slice(2);
const env = { ...process.env };
const cwd = process.cwd();

const initialBuild = spawnSync("pnpm", ["exec", "tsc", "-p", "tsconfig.json"], {
  cwd,
  env,
  stdio: "inherit",
});

if (initialBuild.status !== 0) {
  process.exit(initialBuild.status ?? 1);
}

const tsc = spawn("pnpm", ["exec", "tsc", "--watch", "--preserveWatchOutput"], {
  cwd,
  env,
  stdio: "inherit",
});

const nodeProcess = spawn(process.execPath, ["--watch", "dist/entry.js", ...args], {
  cwd,
  env,
  stdio: "inherit",
});

let exiting = false;

function cleanup(code = 0) {
  if (exiting) return;
  exiting = true;
  nodeProcess.kill("SIGTERM");
  tsc.kill("SIGTERM");
  process.exit(code);
}

process.on("SIGINT", () => cleanup(130));
process.on("SIGTERM", () => cleanup(143));

tsc.on("exit", (code) => {
  if (exiting) return;
  cleanup(code ?? 1);
});

nodeProcess.on("exit", (code, signal) => {
  if (signal || exiting) return;
  cleanup(code ?? 1);
});
