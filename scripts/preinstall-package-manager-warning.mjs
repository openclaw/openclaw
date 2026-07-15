// Enforces the package runtime contract, then warns for non-pnpm lifecycle installs.
import { readFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";

const allowedLifecyclePackageManagers = new Set(["pnpm", "npm", "yarn", "bun"]);
const lifecyclePackageManagerLauncherAliases = new Map([
  ["yarnpkg", "yarn"],
  ["yarn-berry", "yarn"],
]);
const NODE_ENGINE_CLAUSE_RE = /^\s*>=\s*v?(\d+\.\d+\.\d+)(?:\s+<\s*v?(\d+(?:\.\d+\.\d+)?))?\s*$/iu;
const NODE_VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/u;
export const PACKAGE_INSTALL_GUARD_RELATIVE_PATH = "dist/openclaw-install-guard";

function normalizeEnvValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseNodeVersion(value) {
  const match = NODE_VERSION_RE.exec(normalizeEnvValue(value));
  if (!match) {
    return null;
  }
  return {
    major: Number.parseInt(match[1] ?? "", 10),
    minor: Number.parseInt(match[2] ?? "", 10),
    patch: Number.parseInt(match[3] ?? "", 10),
  };
}

function isNodeVersionAtLeast(version, minimum) {
  if (version.major !== minimum.major) {
    return version.major > minimum.major;
  }
  if (version.minor !== minimum.minor) {
    return version.minor > minimum.minor;
  }
  return version.patch >= minimum.patch;
}

/** Checks a Node version against the standalone package engine-range subset. */
export function nodeVersionSatisfiesPackageEngine(version, engine) {
  const parsedVersion = parseNodeVersion(version);
  const normalizedEngine = normalizeEnvValue(engine);
  if (!parsedVersion || !normalizedEngine) {
    return false;
  }

  let satisfied = false;
  for (const clause of normalizedEngine.split("||")) {
    const match = NODE_ENGINE_CLAUSE_RE.exec(clause);
    if (!match) {
      return false;
    }
    const minimum = parseNodeVersion(match[1]);
    const upperRaw = match[2];
    const upper = upperRaw
      ? parseNodeVersion(upperRaw.includes(".") ? upperRaw : `${upperRaw}.0.0`)
      : null;
    if (!minimum || (upperRaw && !upper)) {
      return false;
    }
    if (
      isNodeVersionAtLeast(parsedVersion, minimum) &&
      (!upper || !isNodeVersionAtLeast(parsedVersion, upper))
    ) {
      satisfied = true;
    }
  }
  return satisfied;
}

/** Reads the Node runtime contract from the package being installed. */
export function readPackageNodeEngine(
  packageJsonUrl = new URL("../package.json", import.meta.url),
) {
  try {
    const manifest = JSON.parse(readFileSync(packageJsonUrl, "utf8"));
    return normalizeEnvValue(manifest?.engines?.node) || null;
  } catch {
    return null;
  }
}

/** Rejects installation before an unsupported runtime can replace a working release. */
export function enforceSupportedNodeRuntime(
  {
    version = process.versions.node ?? null,
    bunVersion = process.versions.bun ?? null,
    engine = readPackageNodeEngine(),
    execPath = process.execPath,
  } = {},
  reportError = console.error,
) {
  // Bun itself remains supported for dependency installation and package scripts.
  if (normalizeEnvValue(bunVersion)) {
    return true;
  }
  if (nodeVersionSatisfiesPackageEngine(version, engine)) {
    return true;
  }

  const requirement = engine
    ? `this OpenClaw release requires Node ${engine}.`
    : "could not read this OpenClaw release's Node requirement.";
  reportError(
    [
      `[openclaw] error: ${requirement}`,
      `[openclaw] detected Node ${version ?? "unknown"} (exec: ${execPath || "unknown"}).`,
      "[openclaw] install Node: https://nodejs.org/en/download",
      "[openclaw] upgrade Node, then retry the OpenClaw update.",
    ].join("\n"),
  );
  return false;
}

/** Removes the packed sentinel only after the runtime check succeeds. */
export function completePackageInstallGuard(
  {
    markerUrl = new URL(`../${PACKAGE_INSTALL_GUARD_RELATIVE_PATH}`, import.meta.url),
    remove = rmSync,
  } = {},
  reportError = console.error,
) {
  try {
    remove(markerUrl, { force: true });
    return true;
  } catch (error) {
    reportError(
      `[openclaw] error: could not complete package preinstall: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
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
  if (enforceSupportedNodeRuntime() && completePackageInstallGuard()) {
    warnIfNonPnpmLifecycle();
  } else {
    process.exitCode = 1;
  }
}
