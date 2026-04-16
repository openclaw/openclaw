#!/usr/bin/env node

/**
 * Ensures the OpenClaw gateway watchdog is running under pm2.
 *
 * - If pm2 has no "openclaw-gateway" process, starts one.
 * - If the process exists but is stopped, restarts it.
 * - If already running, prints status and exits.
 *
 * Safe to call repeatedly (idempotent). On Windows, run this from a
 * scheduled task (schtasks) so the pm2 daemon lives in session 0 and
 * survives SSH disconnects.
 *
 * Environment variables for the gateway (OPENCLAW_GATEWAY_TOKEN, etc.)
 * are read from the current environment and baked into the pm2 process
 * via an ecosystem file so they persist across pm2 restarts.
 *
 * Usage:
 *   node scripts/gateway-pm2.mjs [--port 18789] [--branch main] [--remote-poll]
 */

import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const PROCESS_NAME = "openclaw-gateway";

// Forward CLI args (--port, --branch, --remote-poll, etc.) to the watchdog
const forwardArgs = process.argv.slice(2);

// Default args if none provided
if (!forwardArgs.includes("--port")) {
  forwardArgs.push("--port", "18789");
}
if (!forwardArgs.includes("--remote-poll")) {
  forwardArgs.push("--remote-poll");
}
if (!forwardArgs.includes("--branch")) {
  forwardArgs.push("--branch", "main");
}

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe", ...opts }).trim();
}

function ensurePm2() {
  try {
    run("pm2 --version");
  } catch {
    console.log("pm2 not found, installing globally...");
    execSync("npm install -g pm2", { stdio: "inherit" });
  }
}

function getPm2Process() {
  try {
    const json = run("pm2 jlist");
    const list = JSON.parse(json);
    return list.find((p) => p.name === PROCESS_NAME);
  } catch {
    return null;
  }
}

/** Capture gateway-relevant env vars to bake into pm2. */
function getGatewayEnv() {
  const envKeys = ["HOME", "OPENCLAW_GATEWAY_PORT", "OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_LLAMA_GPU"];
  const env = {};
  for (const key of envKeys) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }
  return env;
}

function start() {
  const watchdogScript = path.join(repoRoot, "watchdog", "cli.mjs");
  const args = ["run", ...forwardArgs];
  const env = getGatewayEnv();

  // Write a temporary ecosystem file so pm2 picks up env vars
  const ecosystemPath = path.join(repoRoot, ".pm2-ecosystem.json");
  const ecosystem = {
    apps: [
      {
        name: PROCESS_NAME,
        script: watchdogScript,
        args: args.join(" "),
        cwd: repoRoot,
        merge_logs: true,
        env,
      },
    ],
  };
  writeFileSync(ecosystemPath, JSON.stringify(ecosystem, null, 2));

  console.log(`Starting ${PROCESS_NAME} via pm2...`);
  console.log(`  watchdog: ${watchdogScript}`);
  console.log(`  args: ${args.join(" ")}`);
  if (Object.keys(env).length > 0) {
    console.log(`  env: ${Object.keys(env).join(", ")}`);
  }

  try {
    execSync(`pm2 start ${JSON.stringify(ecosystemPath)}`, {
      stdio: "inherit",
      cwd: repoRoot,
    });
  } finally {
    try {
      unlinkSync(ecosystemPath);
    } catch {}
  }
}

function restart() {
  console.log(`Restarting ${PROCESS_NAME}...`);
  execSync(`pm2 restart ${PROCESS_NAME}`, { stdio: "inherit" });
}

function showStatus() {
  execSync(`pm2 info ${PROCESS_NAME}`, { stdio: "inherit" });
}

// Main
ensurePm2();

const proc = getPm2Process();

if (!proc) {
  // No pm2 process exists — create it
  start();
} else if (proc.pm2_env?.status === "stopped" || proc.pm2_env?.status === "errored") {
  // Exists but not running
  console.log(`${PROCESS_NAME} is ${proc.pm2_env.status}, restarting...`);
  restart();
} else {
  console.log(`${PROCESS_NAME} is already running (pid ${proc.pid})`);
  showStatus();
}
