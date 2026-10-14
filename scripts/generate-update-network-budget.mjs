#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { UPDATE_NETWORK_TIMEOUT_MS } from "../src/infra/update-network-budget.ts";

const check = process.argv.includes("--check");
const seconds = UPDATE_NETWORK_TIMEOUT_MS / 1000;
const start = "# BEGIN GENERATED UPDATE NETWORK BUDGET";
const end = "# END GENERATED UPDATE NETWORK BUDGET";
for (const file of ["scripts/install.sh", "scripts/install-cli.sh", "scripts/install.ps1"]) {
  const powershell = file.endsWith(".ps1");
  const block = [
    start,
    "# Source: src/infra/update-network-budget.ts; regenerate: node scripts/generate-update-network-budget.mjs",
    powershell
      ? `$script:UpdateNetworkTimeoutSeconds = ${seconds}`
      : `UPDATE_NETWORK_TIMEOUT_SECONDS=${seconds}`,
    end,
  ].join("\n");
  const current = readFileSync(file, "utf8");
  const anchor = powershell ? '$ErrorActionPreference = "Stop"\n' : "set -euo pipefail\n";
  const next = current.includes(start)
    ? current.replace(new RegExp(`${start}[\\s\\S]*?${end}`, "u"), block)
    : current.replace(anchor, `${anchor}\n${block}\n`);
  if (!next.includes(block)) {
    throw new Error(`Missing update network budget anchor in ${file}`);
  }
  if (current === next) {
    continue;
  }
  if (check) {
    console.error(`${file} is stale; run node scripts/generate-update-network-budget.mjs`);
    process.exitCode = 1;
  } else {
    writeFileSync(file, next);
  }
}
