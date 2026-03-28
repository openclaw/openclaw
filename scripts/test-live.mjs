import { spawn } from "node:child_process";

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

const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const child = spawn(
  command,
  ["exec", "vitest", "run", "--config", "vitest.live.config.ts", ...forwardedArgs],
  {
    stdio: "inherit",
    env,
  },
);

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
