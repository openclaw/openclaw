#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const tmpDir = process.env.TMPDIR || process.env.TEMP || process.env.TMP || os.tmpdir();
const rssHookPath = path.join(tmpHome, "measure-rss.mjs");
const MAX_RSS_MARKER = "__OPENCLAW_MAX_RSS_KB__=";

writeFileSync(
  rssHookPath,
  [
    "process.on('exit', () => {",
    "  const usage = typeof process.resourceUsage === 'function' ? process.resourceUsage() : null;",
    `  if (usage && typeof usage.maxRSS === 'number') console.error('${MAX_RSS_MARKER}' + String(usage.maxRSS));`,
    "});",
    "",
  ].join("\n"),
  "utf8",
);

const DEFAULT_LIMITS_MB = {
  help: 500,
  statusJson: 900,
  gatewayStatus: 900,
};

const cases = [
  {
    id: "help",
    label: "--help",
    args: ["openclaw.mjs", "--help"],
    limitMb: Number(process.env.OPENCLAW_STARTUP_MEMORY_HELP_MB ?? DEFAULT_LIMITS_MB.help),
  },
  {
    id: "statusJson",
    label: "status --json",
    args: ["openclaw.mjs", "status", "--json"],
    limitMb: Number(
      process.env.OPENCLAW_STARTUP_MEMORY_STATUS_JSON_MB ?? DEFAULT_LIMITS_MB.statusJson,
    ),
  },
  {
    id: "gatewayStatus",
    label: "gateway status",
    args: ["openclaw.mjs", "gateway", "status"],
    limitMb: Number(
      process.env.OPENCLAW_STARTUP_MEMORY_GATEWAY_STATUS_MB ?? DEFAULT_LIMITS_MB.gatewayStatus,
    ),
  },
];

function parseMaxRssMb(stderr) {
  const match = stderr.match(new RegExp(`^${MAX_RSS_MARKER}(\\d+)\\s*$`, "m"));
  if (!match) {
    return null;
  }
  return Number(match[1]) / 1024;
}

function buildBenchEnv() {
  const env = {
    HOME: tmpHome,
    USERPROFILE: tmpHome,
    XDG_CONFIG_HOME: path.join(tmpHome, ".config"),
    XDG_DATA_HOME: path.join(tmpHome, ".local", "share"),
    XDG_CACHE_HOME: path.join(tmpHome, ".cache"),
    PATH: process.env.PATH ?? "",
    TMPDIR: tmpDir,
    TEMP: tmpDir,
    TMP: tmpDir,
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: process.env.TERM ?? "dumb",
  };

  if (process.env.LC_ALL) {
    env.LC_ALL = process.env.LC_ALL;
  }
  if (process.env.CI) {
    env.CI = process.env.CI;
  }
  if (process.env.NODE_DISABLE_COMPILE_CACHE) {
    env.NODE_DISABLE_COMPILE_CACHE = process.env.NODE_DISABLE_COMPILE_CACHE;
  }

  return env;
}

function runCase(testCase) {
  const env = buildBenchEnv();
  const result = spawnSync(process.execPath, ["--import", rssHookPath, ...testCase.args], {
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
