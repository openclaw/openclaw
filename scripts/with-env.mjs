#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import process from "node:process";

const usage = () => {
  console.error("Usage: node scripts/with-env.mjs KEY=value [KEY=value ...] -- command [args...]");
  process.exit(1);
};

const argv = process.argv.slice(2);
const separatorIndex = argv.indexOf("--");

if (separatorIndex === -1) {
  usage();
}

const envAssignments = argv.slice(0, separatorIndex);
const command = argv[separatorIndex + 1];
const args = argv.slice(separatorIndex + 2);

if (!command) {
  usage();
}

const childEnv = { ...process.env };
for (const assignment of envAssignments) {
  const equalsIndex = assignment.indexOf("=");
  if (equalsIndex <= 0) {
    usage();
  }
  childEnv[assignment.slice(0, equalsIndex)] = assignment.slice(equalsIndex + 1);
}

const child = spawn(command, args, {
  cwd: process.cwd(),
  env: childEnv,
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("error", (error) => {
  console.error(`with-env: failed to start "${command}": ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.exit(128 + (osConstants.signals?.[signal] ?? 1));
  }
  process.exit(code ?? 1);
});
