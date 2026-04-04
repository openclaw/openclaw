import { spawnPnpmRunner } from "./pnpm-runner.mjs";

const forwardedArgs = process.argv.slice(2);

if (forwardedArgs.length === 0) {
  console.error("usage: node scripts/run-vitest.mjs <vitest args...>");
  process.exit(1);
}

const child = spawnPnpmRunner({
  pnpmArgs: ["exec", "vitest", ...forwardedArgs],
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
