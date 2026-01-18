#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";

const args = process.argv.slice(2);
const env = { ...process.env };
const cwd = process.cwd();

const tsc = spawn("pnpm", ["exec", "tsc", "--watch", "--preserveWatchOutput"], {
  cwd,
  env,
  stdio: "inherit",
});

let nodeProcess = null;
let exiting = false;

async function waitForEntry() {
  while (!existsSync("dist/entry.js")) {
    if (exiting) return;
    await delay(200);
  }
}

function startNode() {
  nodeProcess = spawn(process.execPath, ["--watch", "dist/entry.js", ...args], {
    cwd,
    env,
    stdio: "inherit",
  });
}

function cleanup(code = 0) {
  if (exiting) return;
  exiting = true;
  nodeProcess?.kill("SIGTERM");
  tsc.kill("SIGTERM");
  process.exit(code);
}

process.on("SIGINT", () => cleanup(130));
process.on("SIGTERM", () => cleanup(143));
process.on("exit", () => cleanup());

tsc.on("exit", (code) => {
  if (exiting) return;
  cleanup(code ?? 1);
});

await waitForEntry();
if (!exiting) startNode();
