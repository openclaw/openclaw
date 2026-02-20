#!/usr/bin/env node

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const cwd = process.cwd();
const packageRoot = fs.existsSync(path.join(cwd, "package.json"))
  ? cwd
  : path.resolve(import.meta.dirname, "..");
const controlUiIndex = path.join(packageRoot, "dist", "control-ui", "index.html");

const checks = [];

function addCheck(name, ok, details, fix) {
  checks.push({ name, ok, details, fix });
}

function safe(command) {
  try {
    return execSync(command, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  } catch (error) {
    if (error && typeof error === "object") {
      const stdout = String(error.stdout || "").trim();
      const stderr = String(error.stderr || "").trim();
      const combined = `${stdout}\n${stderr}`.trim();
      return combined || null;
    }
    return null;
  }
}

const nodeMajor = Number(process.versions.node.split(".")[0] || "0");
addCheck(
  "Node runtime",
  nodeMajor >= 22,
  `Detected Node ${process.versions.node}`,
  "Install Node 22+ and re-run onboarding.",
);

addCheck(
  "Control UI assets",
  fs.existsSync(controlUiIndex),
  fs.existsSync(controlUiIndex) ? `Found ${controlUiIndex}` : `Missing ${controlUiIndex}`,
  "Run: pnpm ui:build",
);

const gatewayStatus = safe("openclaw gateway status");
addCheck(
  "Gateway daemon",
  Boolean(gatewayStatus && !gatewayStatus.toLowerCase().includes("not running")),
  gatewayStatus || "Could not query gateway status",
  "Run: openclaw onboard --install-daemon",
);

const statusOutput = safe("openclaw status");
addCheck(
  "OpenClaw status",
  Boolean(statusOutput),
  statusOutput || "openclaw status command unavailable",
  "Run: openclaw status and resolve reported errors.",
);

const failed = checks.filter((c) => !c.ok);

console.log("AnonymanetworkClawBot quick diagnostics");
console.log("=");
for (const check of checks) {
  console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name}`);
  console.log(`      ${check.details}`);
  if (!check.ok) {
    console.log(`      Fix: ${check.fix}`);
  }
}

if (failed.length) {
  console.log(`\nResult: ${failed.length} check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("\nResult: all checks passed.");
}
