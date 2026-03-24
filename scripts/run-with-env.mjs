#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const WINDOWS_SHELL_EXTENSIONS = new Set([".cmd", ".bat", ".com"]);

function usage() {
  process.stderr.write(
    "Usage: node scripts/run-with-env.mjs KEY=VALUE [KEY=VALUE ...] -- <command> [args...]\n",
  );
}

function shouldUseShellForCommand(command) {
  return (
    process.platform === "win32" &&
    WINDOWS_SHELL_EXTENSIONS.has(path.extname(command).toLowerCase())
  );
}

export async function main(argv = process.argv.slice(2)) {
  const separatorIndex = argv.indexOf("--");
  if (separatorIndex <= 0 || separatorIndex === argv.length - 1) {
    usage();
    return 2;
  }

  const envAssignments = argv.slice(0, separatorIndex);
  const [command, ...args] = argv.slice(separatorIndex + 1);
  const env = { ...process.env };

  for (const assignment of envAssignments) {
    const equalsIndex = assignment.indexOf("=");
    if (equalsIndex <= 0) {
      process.stderr.write(`Invalid env assignment: ${assignment}\n`);
      return 2;
    }
    const key = assignment.slice(0, equalsIndex);
    const value = assignment.slice(equalsIndex + 1);
    env[key] = value;
  }

  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
    ...(shouldUseShellForCommand(command) ? { shell: true } : {}),
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
  const exitCode = await main();
  process.exit(exitCode);
}
