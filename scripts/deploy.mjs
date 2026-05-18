#!/usr/bin/env node

import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("pnpm", ["build"]);
run("docker", ["compose", "restart", "openclaw-gateway"]);

for (;;) {
  const result = spawnSync(
    "docker",
    ["inspect", "openclaw-openclaw-gateway-1", "--format", "{{.State.Health.Status}}"],
    { encoding: "utf8" },
  );
  if (result.status === 0 && result.stdout.trim() === "healthy") {
    break;
  }
  spawnSync("sleep", ["3"], { stdio: "inherit" });
}
