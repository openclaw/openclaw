import { pathToFileURL } from "node:url";

function normalizeEnvValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function detectLifecyclePackageManager(env = process.env) {
  const userAgent = normalizeEnvValue(env.npm_config_user_agent);
  const userAgentMatch = /^([^/\s]+)\//.exec(userAgent);
  if (userAgentMatch) {
    return userAgentMatch[1].toLowerCase();
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  warnIfNonPnpmLifecycle();
}
