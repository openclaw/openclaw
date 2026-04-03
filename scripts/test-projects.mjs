import { spawn } from "node:child_process";
import { acquireLocalHeavyCheckLockSync } from "./lib/local-heavy-check-runtime.mjs";
import { buildVitestArgs } from "./test-projects.test-support.mjs";

const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const vitestArgs = buildVitestArgs(process.argv.slice(2));
const releaseLock = acquireLocalHeavyCheckLockSync({
  cwd: process.cwd(),
  env: process.env,
  lockName: "test",
  toolName: "test",
});
let lockReleased = false;

const releaseLockOnce = () => {
  if (lockReleased) {
    return;
  }
  lockReleased = true;
  releaseLock();
};

const child = spawn(command, vitestArgs, {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  releaseLockOnce();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  releaseLockOnce();
  console.error(error);
  process.exit(1);
});
