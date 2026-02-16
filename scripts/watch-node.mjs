#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const args = process.argv.slice(2);
const env = { ...process.env };
const cwd = process.cwd();
const compiler = "tsdown";
const watchSession = `${Date.now()}-${process.pid}`;
env.OPENCLAW_WATCH_MODE = "1";
env.OPENCLAW_WATCH_SESSION = watchSession;
if (args.length > 0) {
  env.OPENCLAW_WATCH_COMMAND = args.join(" ");
}

const initialBuild = spawnSync("pnpm", ["exec", compiler], {
  cwd,
  env,
  stdio: "inherit",
});

if (initialBuild.status !== 0) {
  process.exit(initialBuild.status ?? 1);
}

const compilerProcess = spawn("pnpm", ["exec", compiler, "--watch"], {
  cwd,
  env,
  stdio: "inherit",
});

const nodeProcess = spawn(process.execPath, ["--watch", "openclaw.mjs", ...args], {
  cwd,
  env,
  stdio: "inherit",
});

let exiting = false;

function cleanup(code = 0) {
  if (exiting) {
    return;
  }
  exiting = true;
  nodeProcess.kill("SIGTERM");
  compilerProcess.kill("SIGTERM");
  process.exit(code);
}

process.on("SIGINT", () => cleanup(130));
process.on("SIGTERM", () => cleanup(143));

compilerProcess.on("exit", (code) => {
  if (exiting) {
    return;
  }
  cleanup(code ?? 1);
});

nodeProcess.on("exit", (code, signal) => {
  if (signal || exiting) {
    return;
  }
  cleanup(code ?? 1);
});
