#!/usr/bin/env node
// Periodic watchdog for default checkout pollution.
// Designed to run from launchd. Detects dirty state and triggers protection.
// Exit codes:
//   0 = clean
//   1 = dirty (incident detected, protection triggered)

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT =
  process.env.OPENCLAW_ROOT ||
  execSync("git rev-parse --show-toplevel", {
    encoding: "utf8",
    cwd: process.env.HOME + "/openclaw",
  }).trim();

function run(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e) {
    return e.stderr?.trim() || e.stdout?.trim() || "";
  }
}

// Check 1: Are we on main?
const branch = run("git symbolic-ref --short HEAD 2>/dev/null") || "DETACHED";
if (branch !== "main") {
  console.error(`🚨 INCIDENT: Default checkout on branch '${branch}', expected 'main'`);
  // Trigger protection
  try {
    execSync(
      `node ${join(ROOT, "scripts/protect-default-checkout-pollution.mjs")} --reason "wrong-branch:${branch}"`,
      {
        cwd: ROOT,
        stdio: "pipe",
      },
    );
  } catch {}
  process.exit(1);
}

// Check 2: Any uncommitted changes?
const statusOutput = run("git status --porcelain");
if (statusOutput) {
  const lines = statusOutput.split("\n").filter((l) => l.trim());
  console.error(`🚨 INCIDENT: Default checkout has ${lines.length} dirty file(s)`);
  for (const line of lines.slice(0, 10)) {
    console.error(`   ${line}`);
  }
  if (lines.length > 10) console.error(`   ... and ${lines.length - 10} more`);

  // Trigger protection
  try {
    execSync(
      `node ${join(ROOT, "scripts/protect-default-checkout-pollution.mjs")} --reason "dirty-files:${lines.length}"`,
      {
        cwd: ROOT,
        stdio: "pipe",
      },
    );
  } catch {}
  process.exit(1);
}

// Check 3: Readonly fence active?
const fenceFile = join(ROOT, ".default-checkout-fence");
if (existsSync(fenceFile)) {
  console.log("🔒 Default checkout locked and clean — OK");
} else {
  console.log("✓ Default checkout clean (unlocked)");
}

process.exit(0);
