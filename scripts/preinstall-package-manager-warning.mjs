import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";

const allowedLifecyclePackageManagers = new Set(["pnpm", "npm", "yarn", "bun"]);
const GIB = 1024 ** 3;
const DEFAULT_MIN_MEM_AVAILABLE_BYTES = 2 * GIB;
const DEFAULT_MIN_SWAP_FREE_BYTES = 1 * GIB;
const DEFAULT_MAX_LOAD1 = 10;

function normalizeEnvValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLifecyclePackageManagerName(value) {
  const normalized = normalizeEnvValue(value).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(normalized)) {
    return null;
  }
  return allowedLifecyclePackageManagers.has(normalized) ? normalized : null;
}

export function detectLifecyclePackageManager(env = process.env) {
  const userAgent = normalizeEnvValue(env.npm_config_user_agent);
  const userAgentMatch = /^([A-Za-z0-9._-]+)\//u.exec(userAgent);
  if (userAgentMatch) {
    return normalizeLifecyclePackageManagerName(userAgentMatch[1]);
  }

  const execPath = normalizeEnvValue(env.npm_execpath).toLowerCase();
  if (execPath.includes("pnpm")) {
    return "pnpm";
  }
  if (execPath.includes("npm")) {
    return "npm";
  }
  if (execPath.includes("yarn")) {
    return "yarn";
  }
  if (execPath.includes("bun")) {
    return "bun";
  }

  return null;
}

export function createPackageManagerWarningMessage(packageManager) {
  if (!packageManager || packageManager === "pnpm") {
    return null;
  }

  return [
    `[openclaw] warning: detected ${packageManager} for install lifecycle.`,
    "[openclaw] this repo works best with pnpm; npm-compatible installs are slower and much larger here.",
    "[openclaw] prefer: corepack pnpm install",
  ].join("\n");
}

export function warnIfNonPnpmLifecycle(env = process.env, warn = console.warn) {
  const message = createPackageManagerWarningMessage(detectLifecyclePackageManager(env));
  if (!message) {
    return false;
  }
  warn(message);
  return true;
}

export function shouldRefuseLocalInstallForPressure(
  env = process.env,
  hostPressure = readHostPressure(),
) {
  if (env.CI === "true" || env.GITHUB_ACTIONS === "true") {
    return { refuse: false, reasons: [] };
  }
  if (env.OPENCLAW_INSTALL_PRESSURE_GUARD === "0" || env.OPENCLAW_HEAVY_CHECK_FORCE === "1") {
    return { refuse: false, reasons: [] };
  }
  if (!hostPressure.isSourceCheckout) {
    return { refuse: false, reasons: [] };
  }

  const minMemAvailableBytes = readPositiveNumber(
    env.OPENCLAW_INSTALL_MIN_MEM_AVAILABLE_BYTES,
    DEFAULT_MIN_MEM_AVAILABLE_BYTES,
  );
  const minSwapFreeBytes = readPositiveNumber(
    env.OPENCLAW_INSTALL_MIN_SWAP_FREE_BYTES,
    DEFAULT_MIN_SWAP_FREE_BYTES,
  );
  const maxLoad1 = readPositiveNumber(env.OPENCLAW_INSTALL_MAX_LOAD1, DEFAULT_MAX_LOAD1);

  const reasons = [];
  if (
    typeof hostPressure.memAvailableBytes === "number" &&
    hostPressure.memAvailableBytes < minMemAvailableBytes
  ) {
    reasons.push(`MemAvailable below ${formatGib(minMemAvailableBytes)}`);
  }
  if (
    typeof hostPressure.swapFreeBytes === "number" &&
    hostPressure.swapFreeBytes < minSwapFreeBytes
  ) {
    reasons.push(`SwapFree below ${formatGib(minSwapFreeBytes)}`);
  }
  if (typeof hostPressure.load1 === "number" && hostPressure.load1 > maxLoad1) {
    reasons.push(`load1 above ${maxLoad1}`);
  }

  return { refuse: reasons.length > 0, reasons };
}

export function createLocalInstallPressureRefusalMessage(result) {
  return [
    "[openclaw] refusing local package install under host pressure.",
    ...result.reasons.map((reason) => `[openclaw] - ${reason}`),
    "[openclaw] retry when the box settles, or set OPENCLAW_INSTALL_PRESSURE_GUARD=0 to override deliberately.",
  ].join("\n");
}

export function readHostPressure({ cwd = process.cwd() } = {}) {
  const meminfo = readMeminfo();
  return {
    isSourceCheckout: isGitSourceCheckout(cwd),
    memAvailableBytes: meminfo.MemAvailable,
    swapFreeBytes: meminfo.SwapFree,
    load1: os.loadavg()[0] ?? 0,
  };
}

export function enforceLocalInstallPressureGuard(
  env = process.env,
  hostPressure = readHostPressure(),
  error = console.error,
) {
  const result = shouldRefuseLocalInstallForPressure(env, hostPressure);
  if (!result.refuse) {
    return false;
  }
  error(createLocalInstallPressureRefusalMessage(result));
  return true;
}

function readMeminfo() {
  try {
    const values = {};
    for (const line of fs.readFileSync("/proc/meminfo", "utf8").split("\n")) {
      const match = /^(MemAvailable|SwapFree):\s+(\d+)\s+kB$/u.exec(line);
      if (match) {
        values[match[1]] = Number.parseInt(match[2], 10) * 1024;
      }
    }
    return values;
  } catch {
    return {};
  }
}

function isGitSourceCheckout(cwd) {
  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && result.stdout.trim() === "true";
}

function readPositiveNumber(rawValue, fallback) {
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatGib(bytes) {
  return `${Math.round(bytes / GIB)}GiB`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  warnIfNonPnpmLifecycle();
  if (enforceLocalInstallPressureGuard()) {
    process.exitCode = 1;
  }
}
