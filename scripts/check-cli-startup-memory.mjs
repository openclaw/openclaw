#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";

if (!isLinux && !isMac) {
  console.log(`[startup-memory] Skipping on unsupported platform: ${process.platform}`);
  process.exit(0);
}

const repoRoot = process.cwd();
const tmpHome = mkdtempSync(path.join(os.tmpdir(), "openclaw-startup-memory-"));

const DEFAULT_LIMITS_MB = {
  help: 500,
  statusJson: 900,
  gatewayStatus: 900,
};

const cases = [
  {
    id: "help",
    label: "--help",
    args: ["node", "openclaw.mjs", "--help"],
    limitMb: Number(process.env.OPENCLAW_STARTUP_MEMORY_HELP_MB ?? DEFAULT_LIMITS_MB.help),
  },
  {
    id: "statusJson",
    label: "status --json",
    args: ["node", "openclaw.mjs", "status", "--json"],
    limitMb: Number(
      process.env.OPENCLAW_STARTUP_MEMORY_STATUS_JSON_MB ?? DEFAULT_LIMITS_MB.statusJson,
    ),
  },
  {
    id: "gatewayStatus",
    label: "gateway status",
    args: ["node", "openclaw.mjs", "gateway", "status"],
    limitMb: Number(
      process.env.OPENCLAW_STARTUP_MEMORY_GATEWAY_STATUS_MB ?? DEFAULT_LIMITS_MB.gatewayStatus,
    ),
  },
];

function parseMaxRssMb(stderr) {
  if (isLinux) {
    const match = stderr.match(/^\s*Maximum resident set size \(kbytes\):\s*(\d+)\s*$/im);
    if (!match) {
      return null;
    }
    return Number(match[1]) / 1024;
  }
  const match = stderr.match(/^\s*(\d+)\s+maximum resident set size\s*$/im);
  if (!match) {
    return null;
  }
  return Number(match[1]) / (1024 * 1024);
}

function runCase(testCase) {
  const env = {
    ...process.env,
    HOME: tmpHome,
    XDG_CONFIG_HOME: path.join(tmpHome, ".config"),
    XDG_DATA_HOME: path.join(tmpHome, ".local", "share"),
    XDG_CACHE_HOME: path.join(tmpHome, ".cache"),
  };
  const timeArgs = isLinux ? ["-v", ...testCase.args] : ["-l", ...testCase.args];
  const result = spawnSync("/usr/bin/time", timeArgs, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const stderr = result.stderr ?? "";
  const maxRssMb = parseMaxRssMb(stderr);
  const matrixBootstrapWarning = /matrix: crypto runtime bootstrap failed/i.test(stderr);

  if (result.status !== 0) {
    throw new Error(
      `${testCase.label} exited with ${String(result.status)}\n${stderr.trim() || result.stdout || ""}`,
    );
  }
  if (maxRssMb == null) {
    throw new Error(`${testCase.label} did not report max RSS\n${stderr.trim()}`);
  }
  if (matrixBootstrapWarning) {
    throw new Error(`${testCase.label} triggered Matrix crypto bootstrap during startup`);
  }
  if (maxRssMb > testCase.limitMb) {
    throw new Error(
      `${testCase.label} used ${maxRssMb.toFixed(1)} MB RSS (limit ${testCase.limitMb} MB)`,
    );
  }

  console.log(
    `[startup-memory] ${testCase.label}: ${maxRssMb.toFixed(1)} MB RSS (limit ${testCase.limitMb} MB)`,
  );
}

try {
  for (const testCase of cases) {
    runCase(testCase);
  }
} finally {
  rmSync(tmpHome, { recursive: true, force: true });
}
