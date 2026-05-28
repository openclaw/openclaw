#!/usr/bin/env node
// Preserve evidence of default checkout pollution without modifying the checkout.
// Copies git status, diff, and log to a timestamped protection directory.
// Does NOT stash, reset, or otherwise alter the checkout.

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const PROTECTION_DIR = resolve(process.env.HOME, ".openclaw/default-checkout-protection");

const reason = process.argv.find((_, i, a) => a[i - 1] === "--reason") || "unknown";
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceDir = join(PROTECTION_DIR, timestamp);

mkdirSync(evidenceDir, { recursive: true });

function capture(label, cmd) {
  try {
    const output = execSync(cmd, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
    writeFileSync(join(evidenceDir, `${label}.txt`), output);
    return true;
  } catch (e) {
    const combined = (e.stdout || "") + "\n" + (e.stderr || "");
    writeFileSync(join(evidenceDir, `${label}.txt`), combined);
    return false;
  }
}

console.log(`📋 Preserving pollution evidence → ${evidenceDir}`);
console.log(`   Reason: ${reason}`);

// Write metadata
const meta = {
  timestamp: new Date().toISOString(),
  reason,
  root: ROOT,
  hostname: execSync("hostname", { encoding: "utf8" }).trim(),
  user: process.env.USER || "unknown",
};
writeFileSync(join(evidenceDir, "metadata.json"), JSON.stringify(meta, null, 2) + "\n");

// Capture evidence
capture("status", "git status");
capture("status-porcelain", "git status --porcelain");
capture("diff", "git diff");
capture("diff-cached", "git diff --cached");
capture("log", "git log --oneline -20");
capture("branch", "git branch -vv");
capture("reflog", "git reflog -20");
capture("untracked", "git ls-files --others --exclude-standard");

console.log(`   Evidence files written:`);
const { readdirSync } = await import("node:fs");
for (const f of readdirSync(evidenceDir)) {
  console.log(`   - ${f}`);
}

console.log("");
console.log("⚠️  Default checkout was NOT modified.");
console.log("   Resolve manually: stash changes, switch to main, sync with origin/main.");
