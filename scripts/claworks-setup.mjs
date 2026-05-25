#!/usr/bin/env node
/**
 * ClaWorks first-run setup — OpenClaw-style onboarding (no long-running gateway).
 *
 *   pnpm claworks:setup
 *   node claworks.mjs onboard --mode local   (after repair)
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".claworks");
const configPath = process.env.OPENCLAW_CONFIG_PATH?.trim() || path.join(stateDir, "claworks.json");

const env = {
  ...process.env,
  CLAWORKS_PRODUCT: "1",
  _CLAWORKS_ARGV1: "claworks.mjs",
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: configPath,
  CLAWORKS_PRODUCT_PROFILE: process.env.CLAWORKS_PRODUCT_PROFILE?.trim() || "extended",
};

function run(args, label) {
  console.log(`\n[claworks:setup] ${label}\n`);
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const passthrough = process.argv.slice(2);
const onboardArgs = ["--import", "tsx", "src/entry.ts", "onboard", "--mode", "local"];
if (passthrough[0] === "--") {
  onboardArgs.push(...passthrough.slice(1));
} else if (passthrough.length > 0) {
  onboardArgs.push(...passthrough);
}

run(
  ["--import", "tsx", "src/entry.ts", "doctor", "--fix", "--non-interactive"],
  "Bootstrap config (doctor --fix)",
);

if (!existsSync(configPath)) {
  run([path.join(root, "scripts/claworks-init.mjs")], "Initialize ClaWorks config");
}

run(onboardArgs, "Interactive setup (onboard)");

console.log("\n[claworks:setup] Done. Recommended path:");
console.log("  pnpm claworks:start              # Gateway on port 18800");
console.log("  pnpm claworks:doctor             # health check");
console.log("  CLAWORKS_INIT_SECURE=1 pnpm claworks:init --force   # production hardening");
console.log("  # personal/self-hosted Qwen + vector KB:");
console.log("  cp contrib/examples/claworks-personal.env.example ~/.claworks/personal.env");
console.log("  source ~/.claworks/personal.env && pnpm claworks:repair:personal\n");
