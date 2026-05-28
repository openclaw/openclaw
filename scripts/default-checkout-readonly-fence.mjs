#!/usr/bin/env node
// Lock/unlock the default checkout to prevent accidental writes.
// Usage:
//   node scripts/default-checkout-readonly-fence.mjs lock
//   node scripts/default-checkout-readonly-fence.mjs unlock
//   node scripts/default-checkout-readonly-fence.mjs status

import { execSync } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const FENCE_FILE = join(ROOT, ".default-checkout-fence");

const command = process.argv[2];

switch (command) {
  case "lock": {
    // Verify clean before locking
    try {
      execSync("git diff --quiet", { cwd: ROOT, stdio: "pipe" });
      execSync("git diff --cached --quiet", { cwd: ROOT, stdio: "pipe" });
    } catch {
      console.error("❌ Cannot lock: default checkout has uncommitted changes");
      console.error("   Clean the checkout first or use check-main-clean.sh");
      process.exit(1);
    }

    const payload = {
      lockedAt: new Date().toISOString(),
      lockedBy: process.env.USER || "unknown",
      head: execSync("git rev-parse HEAD", { cwd: ROOT, encoding: "utf8" }).trim(),
      branch: execSync("git symbolic-ref --short HEAD", { cwd: ROOT, encoding: "utf8" }).trim(),
    };

    writeFileSync(FENCE_FILE, JSON.stringify(payload, null, 2) + "\n");

    // Also add to .gitignore if not already there
    const gitignorePath = join(ROOT, ".gitignore");
    let gitignore = "";
    try {
      gitignore = readFileSync(gitignorePath, "utf8");
    } catch {}
    if (!gitignore.includes(".default-checkout-fence")) {
      const append = "\n# Default checkout readonly fence\n.default-checkout-fence\n";
      writeFileSync(gitignorePath, gitignore.trimEnd() + append + "\n");
    }

    console.log("🔒 Default checkout locked");
    console.log(`   HEAD: ${payload.head.slice(0, 12)}`);
    console.log(`   Branch: ${payload.branch}`);
    console.log(`   Fence: ${FENCE_FILE}`);
    break;
  }

  case "unlock": {
    if (!existsSync(FENCE_FILE)) {
      console.log("✓ Default checkout is not locked");
      break;
    }
    unlinkSync(FENCE_FILE);
    console.log("🔓 Default checkout unlocked");
    console.log("   Remember to re-lock after your work:");
    console.log("   node scripts/default-checkout-readonly-fence.mjs lock");
    break;
  }

  case "status": {
    if (!existsSync(FENCE_FILE)) {
      console.log("🔓 Default checkout: UNLOCKED");
    } else {
      try {
        const payload = JSON.parse(readFileSync(FENCE_FILE, "utf8"));
        console.log("🔒 Default checkout: LOCKED");
        console.log(`   Locked at: ${payload.lockedAt}`);
        console.log(`   Locked by: ${payload.lockedBy}`);
        console.log(`   HEAD: ${payload.head?.slice(0, 12) || "unknown"}`);
        console.log(`   Branch: ${payload.branch || "unknown"}`);
      } catch {
        console.log("🔒 Default checkout: LOCKED (fence file unreadable)");
      }
    }
    break;
  }

  default:
    console.error("Usage: default-checkout-readonly-fence.mjs <lock|unlock|status>");
    process.exit(1);
}
