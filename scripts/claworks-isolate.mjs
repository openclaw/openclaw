#!/usr/bin/env node
/**
 * One-shot ClaWorks isolation repair:
 * - ~/.claworks/claworks.json gateway.port -> 18800
 * - Unload mistaken ai.openclaw.gateway LaunchAgent when it points at ~/.claworks
 * - Reinstall ai.claworks.gateway service on port 18800
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = os.homedir();
const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(home, ".claworks");
const configPath = process.env.OPENCLAW_CONFIG_PATH?.trim() || path.join(stateDir, "claworks.json");
const port = process.env.CLAWORKS_GATEWAY_PORT?.trim() || "18800";

const claworksEnv = {
  ...process.env,
  CLAWORKS_PRODUCT: "1",
  _CLAWORKS_ARGV1: "claworks.mjs",
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: configPath,
  CLAWORKS_GATEWAY_PORT: port,
  OPENCLAW_GATEWAY_PORT: port,
};

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", env: claworksEnv, ...opts });
}

function tryRun(cmd) {
  try {
    run(cmd);
    return true;
  } catch {
    return false;
  }
}

console.log("ClaWorks isolation repair");
console.log(`  state: ${stateDir}`);
console.log(`  config: ${configPath}`);
console.log(`  port: ${port} (OpenClaw keeps 18789)\n`);

run(`node "${path.join(root, "scripts/claworks-repair.mjs")}"`);

const legacyPlist = path.join(home, "Library/LaunchAgents/ai.openclaw.gateway.plist");
if (existsSync(legacyPlist)) {
  const plist = readFileSync(legacyPlist, "utf8");
  if (plist.includes(".claworks") || plist.includes("claworks.json")) {
    console.log("\nRemoving mistaken ClaWorks LaunchAgent on ai.openclaw.gateway …");
    const uid = process.getuid?.() ?? "";
    tryRun(`launchctl bootout "gui/${uid}/ai.openclaw.gateway"`);
    tryRun(`launchctl unload "${legacyPlist}"`);
    tryRun(`rm -f "${legacyPlist}"`);
  }
}

console.log("\nReinstalling ClaWorks gateway service (ai.claworks.gateway) …");

const portNum = Number(port);
const stale = spawnSync("lsof", ["-ti", `:${portNum}`], { encoding: "utf8" });
if (stale.stdout?.trim()) {
  console.log(`Stopping stale process(es) on port ${portNum} …`);
  for (const pid of stale.stdout.trim().split("\n")) {
    tryRun(`kill ${pid.trim()}`);
  }
}

const install = spawnSync(
  process.execPath,
  [path.join(root, "claworks.mjs"), "gateway", "install", "--force"],
  { stdio: "inherit", env: claworksEnv },
);
if (install.status !== 0) {
  console.warn(
    "\nGateway service install failed — start manually:\n" +
      `  cd ${root} && pnpm claworks:gateway\n` +
      `  # or: node claworks.mjs gateway run --port ${port} --bind loopback`,
  );
  process.exit(install.status ?? 1);
}

console.log("\nRestarting ClaWorks gateway …");
tryRun(`node "${path.join(root, "claworks.mjs")}" gateway restart`);

console.log("\nDone. Verify:");
console.log(`  lsof -i :18789 -i :${port}`);
console.log(`  node claworks.mjs gateway status`);
console.log(`  curl http://127.0.0.1:${port}/v1/health`);
