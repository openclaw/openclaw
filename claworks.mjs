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

// CLAWORKS_STATE_DIR takes precedence over the legacy OPENCLAW_STATE_DIR alias.
const stateDir =
  process.env.CLAWORKS_STATE_DIR?.trim() ||
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  path.join(home, ".claworks");

// CLAWORKS_CONFIG takes precedence over OPENCLAW_CONFIG_PATH.
const configPath =
  process.env.CLAWORKS_CONFIG?.trim() ||
  process.env.OPENCLAW_CONFIG_PATH?.trim() ||
  path.join(stateDir, "claworks.json");

const env = {
  ...process.env,
  CLAWORKS_PRODUCT: "1",
  _CLAWORKS_ARGV1: "claworks.mjs",
  // Keep both names consistent so the underlying engine (which reads OPENCLAW_*)
  // and future ClaWorks-native readers (which read CLAWORKS_*) agree.
  CLAWORKS_STATE_DIR: stateDir,
  OPENCLAW_STATE_DIR: stateDir,
  CLAWORKS_CONFIG: configPath,
  OPENCLAW_CONFIG_PATH: configPath,
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
