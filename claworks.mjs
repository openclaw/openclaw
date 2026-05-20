#!/usr/bin/env node
/**
 * ClaWorks standalone CLI entry.
 * Isolated from OpenClaw: ~/.claworks state, claworks.json config, default port 18800.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const home = os.homedir();
const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(home, ".claworks");

const env = {
  ...process.env,
  CLAWORKS_PRODUCT: "1",
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH:
    process.env.OPENCLAW_CONFIG_PATH?.trim() || path.join(stateDir, "claworks.json"),
  CLAWORKS_GATEWAY_PORT: process.env.CLAWORKS_GATEWAY_PORT || "18800",
};

const child = spawn(process.execPath, [path.join(root, "openclaw.mjs"), ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
