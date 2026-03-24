#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

function hasBash() {
  const probe = spawnSync("bash", ["--version"], {
    cwd: process.cwd(),
    stdio: "ignore",
    shell: false,
  });
  return (probe.status ?? 1) === 0;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0) {
    process.stderr.write("Usage: node scripts/run-bash-script.mjs <script-or-args...>\n");
    return 2;
  }

  if (!hasBash()) {
    process.stderr.write("This script requires bash. Install Git Bash or use WSL, then retry.\n");
    return 1;
  }

  const child = spawn("bash", argv, {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: false,
  });

  return await new Promise((resolve) => {
    child.on("error", (error) => {
      process.stderr.write(`${String(error.message ?? error)}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await main());
}
