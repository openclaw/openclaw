#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

export async function main(argv = process.argv.slice(2)) {
  const separatorIndex = argv.indexOf("--");
  if (separatorIndex < 2 || separatorIndex === argv.length - 1) {
    process.stderr.write(
      "Usage: node scripts/require-platform-run.mjs <platforms> <message> -- <command> [args...]\n",
    );
    return 2;
  }

  const allowedPlatforms = argv[0]
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const message = argv[1];
  const [command, ...args] = argv.slice(separatorIndex + 1);

  if (!allowedPlatforms.includes(process.platform)) {
    process.stderr.write(`${message}\nCurrent platform: ${process.platform}\n`);
    return 1;
  }

  const child = spawn(command, args, {
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
