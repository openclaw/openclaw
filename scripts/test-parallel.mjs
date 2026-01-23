import { spawn } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const runs = [
  {
    name: "unit",
    args: ["vitest", "run", "--config", "vitest.unit.config.ts"],
  },
  {
    name: "gateway",
    args: ["vitest", "run", "--config", "vitest.gateway.config.ts"],
  },
];

const children = new Set();

const run = (entry) =>
  new Promise((resolve) => {
    const child = spawn(pnpm, entry.args, {
      stdio: "inherit",
      env: { ...process.env, VITEST_GROUP: entry.name },
    });
    children.add(child);
    child.on("exit", (code, signal) => {
      children.delete(child);
      resolve(code ?? (signal ? 1 : 0));
    });
  });

const shutdown = (signal) => {
  for (const child of children) {
    child.kill(signal);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const codes = await Promise.all(runs.map(run));
const failed = codes.find((code) => code !== 0);
process.exit(failed ?? 0);
