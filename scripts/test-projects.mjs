import { spawn } from "node:child_process";
import { buildVitestArgs } from "./test-projects.test-support.mjs";

const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const vitestArgs = buildVitestArgs(process.argv.slice(2));

const child = spawn(command, vitestArgs, {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
