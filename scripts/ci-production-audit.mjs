#!/usr/bin/env node

// Runs the target's production dependency audit for CI's security-fast job.
// Trusted harness code: CI dispatched by release validation or publication records a
// failing audit as a warning, because dependency advisories never block a release.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const RELEASE_DISPATCH_PREFIXES = ["full-release-validation-", "release-native-android-"];

function isReleaseDispatch() {
  if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" || !process.env.GITHUB_EVENT_PATH) {
    return false;
  }
  try {
    const dispatchId = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")).inputs
      ?.dispatch_id;
    return (
      typeof dispatchId === "string" &&
      RELEASE_DISPATCH_PREFIXES.some((prefix) => dispatchId.startsWith(prefix))
    );
  } catch {
    return false;
  }
}

const audit = spawnSync(
  process.execPath,
  ["scripts/pre-commit/pnpm-audit-prod.mjs", "--audit-level=high"],
  { stdio: "inherit" },
);
const status = audit.status ?? 1;
const nonBlocking = status !== 0 && isReleaseDispatch();
if (nonBlocking) {
  process.stdout.write(
    `::warning title=Dependency advisories do not block releases::Production dependency audit exited ${status}. Release CI records this without failing; queue the dependency bump on main after publication.\n`,
  );
}
process.exitCode = nonBlocking ? 0 : status;
