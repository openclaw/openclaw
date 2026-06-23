// Warns during install lifecycle when a package manager other than pnpm is used.
import { pathToFileURL } from "node:url";

const allowedLifecyclePackageManagers = new Set(["pnpm", "npm", "yarn", "bun"]);
const lifecyclePackageManagerLauncherAliases = new Map([
  ["yarnpkg", "yarn"],
  ["yarn-berry", "yarn"],
]);

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

function detectLifecyclePackageManagerFromExecPath(value) {
  const execPath = normalizeEnvValue(value).toLowerCase();
  const executableName = execPath.split(/[\\/]/u).findLast((segment) => segment.length > 0) ?? "";
  const launcherName = executableName.replace(/\.(?:c?js|mjs|cmd|ps1|exe)$/u, "");
  const candidates = [launcherName, launcherName.replace(/-cli$/u, "")];

  for (const candidate of candidates) {
    if (/^yarn(?:pkg)?-\d/u.test(candidate)) {
      return "yarn";
    }

    const aliasedPackageManager = lifecyclePackageManagerLauncherAliases.get(candidate);
    if (aliasedPackageManager) {
      return aliasedPackageManager;
    }

    const packageManager = normalizeLifecyclePackageManagerName(candidate);
    if (packageManager) {
      return packageManager;
    }
  }

  return null;
}

/**
 * Detects the package manager running the current lifecycle script.
 */
export function detectLifecyclePackageManager(env = process.env) {
  const userAgent = normalizeEnvValue(env.npm_config_user_agent);
  const userAgentMatch = /^([A-Za-z0-9._-]+)\//u.exec(userAgent);
  if (userAgentMatch) {
    return normalizeLifecyclePackageManagerName(userAgentMatch[1]);
  }

  return detectLifecyclePackageManagerFromExecPath(env.npm_execpath);
}

/**
 * Builds the warning shown for non-pnpm lifecycle installs.
 */
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

/**
 * Emits the non-pnpm lifecycle warning when needed.
 */
export function warnIfNonPnpmLifecycle(env = process.env, warn = console.warn) {
  const message = createPackageManagerWarningMessage(detectLifecyclePackageManager(env));
  if (!message) {
    return false;
  }
  warn(message);
  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  warnIfNonPnpmLifecycle();
}
