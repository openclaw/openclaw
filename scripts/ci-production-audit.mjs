#!/usr/bin/env node

// CI and pre-commit share warn-only reporting; the daily audit stays strict.
import { spawnSync } from "node:child_process";
import process from "node:process";

const audit = spawnSync(
  process.execPath,
  ["scripts/pre-commit/pnpm-audit-prod.mjs", "--audit-level=high"],
  { stdio: "inherit" },
);
const status = audit.status ?? 1;
if (status !== 0) {
  process.stdout.write(
    `::warning title=Dependency audit is non-blocking::Production dependency audit exited ${status}. See the daily Dependency Audit workflow for triage and follow up with a dependency bump on main; advisories never block CI, commits, or releases.\n`,
  );
}
process.exitCode = 0;
