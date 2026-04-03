import { acquireLocalHeavyCheckLockSync } from "./lib/local-heavy-check-runtime.mjs";
import { spawnPnpmRunner } from "./pnpm-runner.mjs";
import { buildVitestArgs } from "./test-projects.test-support.mjs";

const vitestArgs = buildVitestArgs(process.argv.slice(2));
const releaseLock = acquireLocalHeavyCheckLockSync({
  cwd: process.cwd(),
  env: process.env,
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

const child = spawnPnpmRunner({
  pnpmArgs: vitestArgs,
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
