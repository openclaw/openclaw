import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const includeArchitecture = process.argv.includes("--include-architecture");

const stages = [
  { name: "conflict markers", args: ["check:no-conflict-markers"] },
  { name: "tool display", args: ["tool-display:check"] },
  { name: "host env policy", args: ["check:host-env-policy:swift"] },
  { name: "typecheck", args: ["tsgo:all"] },
  { name: "lint", args: ["lint"] },
  { name: "webhook body guard", args: ["lint:webhook:no-low-level-body-read"] },
  { name: "pairing store guard", args: ["lint:auth:no-pairing-store-group"] },
  { name: "pairing account guard", args: ["lint:auth:pairing-account-scope"] },
  { name: "runtime import cycles", args: ["check:import-cycles"] },
];

if (includeArchitecture) {
  stages.push({ name: "architecture import cycles", args: ["check:madge-import-cycles"] });
}

const timings = [];
let exitCode = 0;

for (const { name, args } of stages) {
  const startedAt = performance.now();
  console.error(`\n[check:timed] ${name}`);
  const result = spawnSync("pnpm", args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  const durationMs = performance.now() - startedAt;
  timings.push({ name, durationMs, status: result.status ?? 1 });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    exitCode = result.status ?? 1;
    break;
  }
}

console.error("\n[check:timed] summary");
for (const timing of timings) {
  const status = timing.status === 0 ? "ok" : `failed:${timing.status}`;
  console.error(`${formatMs(timing.durationMs).padStart(8)}  ${status.padEnd(9)}  ${timing.name}`);
}

process.exitCode = exitCode;

function formatMs(durationMs) {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }
  return `${(durationMs / 1000).toFixed(2)}s`;
}
