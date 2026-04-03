import { spawnPnpmRunner } from "./pnpm-runner.mjs";

const forwardedArgs = [];
let quietOverride;

for (const arg of process.argv.slice(2)) {
  if (arg === "--") {
    continue;
  }
  if (arg === "--quiet" || arg === "--quiet-live") {
    quietOverride = "1";
    continue;
  }
  if (arg === "--no-quiet" || arg === "--no-quiet-live") {
    quietOverride = "0";
    continue;
  }
  forwardedArgs.push(arg);
}

const env = {
  ...process.env,
  OPENCLAW_LIVE_TEST: process.env.OPENCLAW_LIVE_TEST || "1",
  OPENCLAW_LIVE_TEST_QUIET: quietOverride ?? process.env.OPENCLAW_LIVE_TEST_QUIET ?? "1",
};

const child = spawnPnpmRunner({
  pnpmArgs: ["exec", "vitest", "run", "--config", "vitest.live.config.ts", ...forwardedArgs],
  env,
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
