#!/usr/bin/env node
// Ensures Playwright Chromium is installed or a usable system browser is available.
import { spawnSync as spawnSyncImpl } from "node:child_process";
import { existsSync as existsSyncImpl, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { resolvePnpmRunner } from "./pnpm-runner.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const playwrightInstallBaseArgs = ["--dir", "ui", "exec", "playwright", "install"];
const executableOverrideEnvKey = "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH";
/**
 * System Chromium executable paths used before downloading Playwright browsers.
 */
export const systemChromiumExecutableCandidates = [
  "/snap/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
];

/**
 * Checks whether a Chromium executable can start enough to print its version.
 */
export function canRunChromiumExecutable(executablePath, spawnSync = spawnSyncImpl) {
  const result = spawnSync(executablePath, ["--version"], {
    stdio: "ignore",
  });
  return result.status === 0;
}

/**
 * Resolves the first runnable system Chromium executable path.
 */
export function resolveSystemChromiumExecutablePath(
  existsSync = existsSyncImpl,
  spawnSync = spawnSyncImpl,
) {
  return (
    systemChromiumExecutableCandidates.find(
      (candidate) => existsSync(candidate) && canRunChromiumExecutable(candidate, spawnSync),
    ) ?? ""
  );
}

/**
 * Builds the pnpm runner invocation for Playwright browser install.
 */
export function resolvePlaywrightInstallRunner(options = {}) {
  const env = options.env ?? process.env;
  const targets = options.targets ?? ["chromium"];
  return resolvePnpmRunner({
    comSpec: options.comSpec,
    env,
    npmExecPath: env === process.env ? env.npm_execpath : (env.npm_execpath ?? ""),
    platform: options.platform,
    pnpmArgs: [
      ...playwrightInstallBaseArgs,
      ...(options.withDeps ? ["--with-deps"] : []),
      ...targets,
    ],
  });
}

function isTruthyEnvFlag(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * Reports whether Linux system dependencies should be installed with Chromium.
 */
export function shouldInstallPlaywrightSystemDependencies(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const getuid = options.getuid ?? process.getuid;
  if (platform !== "linux") {
    return false;
  }
  if (typeof getuid === "function" && getuid() === 0) {
    return true;
  }
  return (
    isTruthyEnvFlag(env.CI) ||
    isTruthyEnvFlag(env.GITHUB_ACTIONS) ||
    isTruthyEnvFlag(env.OPENCLAW_TESTBOX)
  );
}

/**
 * Checks whether this module is the direct script entrypoint.
 */
export function isDirectScriptExecution(
  argvEntry = process.argv[1],
  modulePath = fileURLToPath(import.meta.url),
  realpath = realpathSync.native,
) {
  if (!argvEntry) {
    return false;
  }
  try {
    return realpath(argvEntry) === realpath(modulePath);
  } catch {
    return resolve(argvEntry) === resolve(modulePath);
  }
}

/**
 * Ensures a runnable Chromium exists for Playwright-based UI tests.
 */
export function ensurePlaywrightChromium(options = {}) {
  const env = options.env ?? process.env;
  const executableOverride =
    typeof env[executableOverrideEnvKey] === "string" ? env[executableOverrideEnvKey].trim() : "";
  const executablePath = options.executablePath ?? chromium.executablePath();
  const existsSync = options.existsSync ?? existsSyncImpl;
  const log = options.log ?? console.error;
  const spawnSync = options.spawnSync ?? spawnSyncImpl;
  const runPlaywrightInstall = (targets = ["chromium"], withDeps = false) => {
    const runner = resolvePlaywrightInstallRunner({
      comSpec: options.comSpec,
      env,
      platform: options.platform,
      targets,
      withDeps,
    });
    const result = spawnSync(runner.command, runner.args, {
      cwd: options.cwd ?? repoRoot,
      env,
      shell: runner.shell,
      stdio: options.stdio ?? "inherit",
      windowsVerbatimArguments: runner.windowsVerbatimArguments,
    });
    return result.status ?? 1;
  };
  const ensureFfmpeg = () => {
    if (!options.ensureFfmpeg) {
      return 0;
    }
    const status = runPlaywrightInstall(["ffmpeg"]);
    if (status !== 0) {
      log(`[ui-e2e] Playwright ffmpeg install failed with status ${status}.`);
    }
    return status;
  };

  if (executableOverride) {
    if (existsSync(executableOverride) && canRunChromiumExecutable(executableOverride, spawnSync)) {
      return ensureFfmpeg();
    }
    log(
      `[ui-e2e] ${executableOverrideEnvKey} points to ${executableOverride}, but that browser is not runnable.`,
    );
    return 1;
  }

  if (existsSync(executablePath) && canRunChromiumExecutable(executablePath, spawnSync)) {
    return ensureFfmpeg();
  }

  const systemExecutablePath =
    options.systemExecutablePath ?? resolveSystemChromiumExecutablePath(existsSync, spawnSync);
  if (systemExecutablePath && canRunChromiumExecutable(systemExecutablePath, spawnSync)) {
    log(`[ui-e2e] Using system Chromium at ${systemExecutablePath}.`);
    return ensureFfmpeg();
  }

  if (env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1") {
    log(
      `[ui-e2e] Playwright Chromium is missing at ${executablePath}; OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 leaves the lane skipped.`,
    );
    return 0;
  }

  log(`[ui-e2e] Playwright Chromium is not runnable at ${executablePath}; installing chromium.`);
  const canInstallSystemDependencies = shouldInstallPlaywrightSystemDependencies({
    env,
    getuid: options.getuid,
    platform: options.platform,
  });
  const status = runPlaywrightInstall();
  if (status !== 0) {
    if (canInstallSystemDependencies) {
      log(
        `[ui-e2e] Chromium install failed in a Linux CI/root lane; installing Linux system dependencies.`,
      );
      const depsStatus = runPlaywrightInstall(["chromium"], true);
      if (depsStatus !== 0) {
        return depsStatus;
      }
      if (existsSync(executablePath) && canRunChromiumExecutable(executablePath, spawnSync)) {
        return ensureFfmpeg();
      }
      log(
        `[ui-e2e] Playwright install completed but Chromium is still not runnable at ${executablePath}.`,
      );
      return 1;
    }
    return status;
  }

  if (!existsSync(executablePath) || !canRunChromiumExecutable(executablePath, spawnSync)) {
    if (canInstallSystemDependencies) {
      log(
        `[ui-e2e] Chromium is installed but still cannot start; installing Linux system dependencies.`,
      );
      const depsStatus = runPlaywrightInstall(["chromium"], true);
      if (depsStatus !== 0) {
        return depsStatus;
      }
      if (existsSync(executablePath) && canRunChromiumExecutable(executablePath, spawnSync)) {
        return ensureFfmpeg();
      }
    }
    log(
      `[ui-e2e] Playwright install completed but Chromium is still not runnable at ${executablePath}.`,
    );
    return 1;
  }
  return ensureFfmpeg();
}

if (isDirectScriptExecution()) {
  process.exitCode = ensurePlaywrightChromium({ ensureFfmpeg: true });
}
