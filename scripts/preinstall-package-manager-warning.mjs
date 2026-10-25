import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync, rmSync } from "node:fs";
import { posix, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isNodeVersionAtLeast,
  MINIMUM_BUN_VERSION,
  parseNodeReleaseVersion,
} from "../node-version.mjs";
import { createRuntimeProcessScriptFile } from "../runtime-process-scripts.generated.mjs";
import { LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH } from "./lib/package-lifecycle-marker.mjs";

const allowedLifecyclePackageManagers = new Set(["pnpm", "npm", "yarn", "bun"]);
const lifecyclePackageManagerLauncherAliases = new Map([
  ["yarnpkg", "yarn"],
  ["yarn-berry", "yarn"],
]);
const NODE_ENGINE_CLAUSE_RE = /^\s*>=\s*v?(\d+\.\d+\.\d+)(?:\s+<\s*v?(\d+(?:\.\d+\.\d+)?))?\s*$/iu;
const PACKAGE_CLI_NODE_PROBE_TIMEOUT_MS = 10_000;
/**
 * @typedef {{
 *   version: string | null;
 *   bunVersion: string | null;
 *   execPath: string | null;
 * }} PackageCliNodeRuntime
 */

/**
 * @typedef {{
 *   status?: number | null;
 *   stdout?: string;
 *   error?: NodeJS.ErrnoException;
 * }} PackageCliNodeProbeResult
 */

/**
 * @typedef {(command: string, args: string[], options: {
 *   cwd: string;
 *   encoding: "utf8";
 *   env: NodeJS.ProcessEnv;
 *   timeout: number;
 *   windowsHide: boolean;
 * }) => PackageCliNodeProbeResult} PackageCliNodeProbeRun
 */

function normalizeEnvValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Checks a Node version against the standalone package engine-range subset.
 * @param {string | null} version
 * @param {string | null} engine
 * @returns {boolean}
 */
export function nodeVersionSatisfiesPackageEngine(version, engine) {
  const parsedVersion = parseNodeReleaseVersion(version);
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
    const minimum = parseNodeReleaseVersion(match[1]);
    const upperRaw = match[2];
    const upper = upperRaw
      ? parseNodeReleaseVersion(upperRaw.includes(".") ? upperRaw : `${upperRaw}.0.0`)
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

/**
 * @param {URL} [packageJsonUrl]
 * @returns {string | null}
 */
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

function parseNodeRuntimeProbeOutput(value) {
  try {
    const parsed = JSON.parse(normalizeEnvValue(value));
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      version: normalizeEnvValue(parsed.version) || null,
      bunVersion: normalizeEnvValue(parsed.bunVersion) || null,
      execPath: normalizeEnvValue(parsed.execPath) || null,
    };
  } catch {
    return null;
  }
}

function normalizePathForComparison(value, pathApi, platform) {
  const normalized = pathApi.normalize(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isStableAbsolutePath(value, pathApi, platform) {
  if (!pathApi.isAbsolute(value)) {
    return false;
  }
  if (platform !== "win32") {
    return true;
  }
  const root = pathApi.parse(value).root;
  return root !== "\\" && root !== "/";
}

function stripBunLifecyclePaths(pathEntries, cwd, pathApi, platform, dependencyLifecycle) {
  const lifecyclePaths = [];
  let directory = pathApi.resolve(cwd);
  while (true) {
    lifecyclePaths.push(pathApi.join(directory, "node_modules", ".bin"));
    const parent = pathApi.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  if (pathEntries.length < lifecyclePaths.length) {
    return null;
  }
  const matches = (entry, expected) =>
    normalizePathForComparison(entry, pathApi, platform) ===
    normalizePathForComparison(expected, pathApi, platform);
  for (
    let prefixLength = dependencyLifecycle ? 1 : lifecyclePaths.length;
    prefixLength <= lifecyclePaths.length;
    prefixLength++
  ) {
    if (
      !lifecyclePaths
        .slice(0, prefixLength)
        .every((expected, index) => matches(pathEntries[index], expected))
    ) {
      return null;
    }
    const suffixStart = pathEntries.length - (lifecyclePaths.length - prefixLength);
    const suffixMatches = lifecyclePaths
      .slice(prefixLength)
      .every((expected, index) => matches(pathEntries[suffixStart + index], expected));
    if (suffixMatches) {
      // Dependency lifecycles can include private-store bins before inherited PATH.
      return pathEntries.slice(prefixLength, suffixStart);
    }
  }
  return null;
}

/**
 * Finds persistent Node, or an explicit Bun launcher after exhausting the lifecycle PATH.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv;
 *   pathEnv?: string;
 *   platform?: NodeJS.Platform;
 *   cwd?: string;
 *   execPath?: string;
 *   bunVersion?: string | null;
 *   access?: (path: string, mode: number) => void;
 *   realpath?: (path: string) => string;
 *   run?: PackageCliNodeProbeRun;
 * }} [options]
 * @returns {PackageCliNodeRuntime | null}
 */
export function probePackageCliNodeRuntime(options = {}) {
  const {
    env = process.env,
    pathEnv = env.PATH ?? "",
    platform = process.platform,
    cwd = process.cwd(),
    execPath = process.execPath,
    bunVersion = process.versions.bun ?? null,
    access = accessSync,
    realpath = realpathSync,
    run = spawnSync,
  } = options;
  const pathApi = platform === "win32" ? win32 : posix;
  const delimiter = platform === "win32" ? ";" : ":";
  const executableName = platform === "win32" ? "node.exe" : "node";
  const seen = new Set();
  // Bun 1.4.4 moved dependency ancestor bins after inherited PATH. Root scripts
  // and older Bun keep the full prefix. PATH alone cannot distinguish them when
  // inherited entries also name ancestor bins; use the runtime and package root.
  const reorderedLifecycle = isNodeVersionAtLeast(parseNodeReleaseVersion(bunVersion), {
    major: 1,
    minor: 4,
    patch: 4,
  });
  const localPrefix = normalizeEnvValue(env.npm_config_local_prefix);
  if (reorderedLifecycle && !isStableAbsolutePath(localPrefix, pathApi, platform)) {
    return null;
  }
  const dependencyLifecycle =
    reorderedLifecycle &&
    normalizePathForComparison(localPrefix, pathApi, platform) !==
      normalizePathForComparison(pathApi.resolve(cwd), pathApi, platform);
  const pathEntries = stripBunLifecyclePaths(
    pathEnv.split(delimiter),
    cwd,
    pathApi,
    platform,
    dependencyLifecycle,
  );
  if (!pathEntries) {
    return null;
  }
  const probe = (candidate) => {
    const childEnv = { ...env };
    for (const key of Object.keys(childEnv)) {
      if (key.toUpperCase() === "NODE_OPTIONS") {
        delete childEnv[key];
      }
    }
    const script = createRuntimeProcessScriptFile("packageCliNodeProbe");
    try {
      return run(candidate, [fileURLToPath(script.url)], {
        cwd,
        encoding: "utf8",
        env: childEnv,
        timeout: PACKAGE_CLI_NODE_PROBE_TIMEOUT_MS,
        windowsHide: true,
      });
    } finally {
      script.dispose();
    }
  };

  for (const entry of pathEntries) {
    if (!entry || !isStableAbsolutePath(entry, pathApi, platform)) {
      // Relative paths, including Windows root-relative paths, resolve against
      // each future CLI invocation's cwd or drive.
      // No preinstall probe can safely approve the Node they may select later.
      return null;
    }
    const candidate = pathApi.join(entry, executableName);
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    try {
      // PATH lookup skips absent and nonexecutable files without launching them.
      access(candidate, constants.X_OK);
    } catch (error) {
      if (["EACCES", "ENOENT", "ENOTDIR"].includes(error?.code)) {
        continue;
      }
      return null;
    }
    try {
      // Skip stock/fork Bun lifecycle shims, never persistent node aliases.
      if (
        /^bun-node-(?:[0-9a-f]+|[0-9]+-(?:[0-9a-f]+|debug)(?:-[0-9a-f]{16})?)$/u.test(
          pathApi.basename(pathApi.dirname(candidate)),
        ) &&
        realpath(candidate) === realpath(execPath)
      ) {
        continue;
      }
    } catch {
      // Let the executable probe handle missing or inaccessible paths.
    }
    const result = probe(candidate);
    if (
      result?.error?.code === "EACCES" ||
      result?.error?.code === "ENOENT" ||
      result?.error?.code === "ENOTDIR"
    ) {
      continue;
    }
    if (result?.status !== 0) {
      return null;
    }

    const runtime = parseNodeRuntimeProbeOutput(result.stdout);
    // A Bun-backed candidate from the original PATH remains first after install.
    // It cannot satisfy the package's Node engine contract, so fail closed.
    if (!runtime || runtime.bunVersion) {
      return null;
    }
    return runtime;
  }

  const launcher = normalizeEnvValue(env.OPENCLAW_PACKAGE_BUN_LAUNCHER);
  if (!isStableAbsolutePath(launcher, pathApi, platform)) {
    return null;
  }
  const result = probe(launcher);
  const runtime = result?.status === 0 ? parseNodeRuntimeProbeOutput(result.stdout) : null;
  return runtime?.bunVersion ? runtime : null;
}

/**
 * Rejects installation before an unsupported runtime can replace a working release.
 * @param {{
 *   version?: string | null;
 *   bunVersion?: string | null;
 *   engine?: string | null;
 *   execPath?: string | null;
 *   probeNodeRuntime?: () => PackageCliNodeRuntime | null;
 * }} [options]
 * @param {(...data: unknown[]) => void} [reportError]
 * @returns {boolean}
 */
export function enforceSupportedNodeRuntime(
  {
    version = process.versions.node ?? null,
    bunVersion = process.versions.bun ?? null,
    engine = readPackageNodeEngine(),
    execPath = process.execPath,
    probeNodeRuntime = probePackageCliNodeRuntime,
  } = {},
  reportError = console.error,
) {
  const detectedRuntime = normalizeEnvValue(bunVersion)
    ? probeNodeRuntime()
    : { version, execPath };
  if (detectedRuntime?.bunVersion) {
    if (
      isNodeVersionAtLeast(parseNodeReleaseVersion(detectedRuntime.bunVersion), MINIMUM_BUN_VERSION)
    ) {
      return true;
    }
    reportError(
      `[openclaw] error: Bun launcher ${detectedRuntime.execPath ?? execPath} requires Bun 1.4.3+ (detected ${detectedRuntime.bunVersion}).`,
    );
    return false;
  }
  if (nodeVersionSatisfiesPackageEngine(detectedRuntime?.version ?? null, engine)) {
    return true;
  }

  const requirement = engine
    ? `this OpenClaw release requires Node ${engine}.`
    : "could not read this OpenClaw release's Node requirement.";
  reportError(
    [
      `[openclaw] error: ${requirement}`,
      `[openclaw] detected Node ${detectedRuntime?.version ?? "missing"} (exec: ${detectedRuntime?.execPath || "unknown"}).`,
      "[openclaw] install Node: https://nodejs.org/en/download",
      "[openclaw] upgrade Node, then retry the OpenClaw update.",
    ].join("\n"),
  );
  return false;
}

/**
 * Removes the 2026.8.1 dist sentinel after the runtime check succeeds.
 * @param {{
 *   markerUrl?: URL;
 *   remove?: (path: URL, options: { force: boolean }) => void;
 * }} [options]
 * @param {(...data: unknown[]) => void} [reportError]
 * @returns {boolean}
 */
export function removeLegacyPackageInstallGuard(
  {
    markerUrl = new URL(`../${LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH}`, import.meta.url),
    remove = rmSync,
  } = {},
  reportError = console.error,
) {
  try {
    remove(markerUrl, { force: true });
    return true;
  } catch (error) {
    reportError(
      `[openclaw] error: could not remove the legacy package install guard: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

function normalizeLifecyclePackageManagerName(value) {
  const normalized = normalizeEnvValue(value).toLowerCase();
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
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
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
 * @param {NodeJS.ProcessEnv} [env]
 * @param {(...data: unknown[]) => void} [warn]
 * @returns {boolean}
 */
export function warnIfNonPnpmLifecycle(env = process.env, warn = console.warn) {
  const packageManager = detectLifecyclePackageManager(env);
  if (!packageManager || packageManager === "pnpm") {
    return false;
  }
  warn(
    [
      `[openclaw] warning: detected ${packageManager} for install lifecycle.`,
      "[openclaw] this repo works best with pnpm; npm-compatible installs are slower and much larger here.",
      "[openclaw] prefer: corepack pnpm install",
    ].join("\n"),
  );
  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (enforceSupportedNodeRuntime() && removeLegacyPackageInstallGuard()) {
    warnIfNonPnpmLifecycle();
  } else {
    process.exitCode = 1;
  }
}
