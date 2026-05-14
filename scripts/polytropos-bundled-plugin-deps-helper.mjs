#!/usr/bin/env node
/**
 * Polytropos-owned fork of the bundled plugin deps helper.
 *
 * Why this exists:
 * - The upstream helper (`scripts/postinstall-bundled-plugins.mjs`) is designed to run only in a global npm
 *   install context (it checks `npm_config_global`), and is loaded from the installed package.
 * - The Polytropos release flow wants a stable, repo-owned implementation that can be invoked explicitly
 *   against a specific installed package root (and is ready for future Polytropos-specific changes).
 *
 * Compatibility:
  * - Core logic mirrors the upstream helper: discover runtime deps declared by bundled plugins under
 *   `dist/extensions/<pluginId>/package.json`, then ensure those deps exist at the package root `node_modules`.
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BUNDLED_PLUGIN_INSTALL_TARGETS = [];

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACKAGE_ROOT = resolve(__dirname, "..");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function dependencySentinelPath(depName) {
  return join("node_modules", ...depName.split("/"), "package.json");
}

function collectRuntimeDeps(packageJson) {
  return {
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
  };
}

export function discoverBundledPluginRuntimeDeps(params = {}) {
  const extensionsDir = params.extensionsDir;
  const pathExists = params.existsSync ?? existsSync;
  const readDir = params.readdirSync ?? readdirSync;
  const readJsonFile = params.readJson ?? readJson;
  const deps = new Map(
    BUNDLED_PLUGIN_INSTALL_TARGETS.map((target) => [
      target.name,
      {
        name: target.name,
        version: target.version,
        sentinelPath: dependencySentinelPath(target.name),
        pluginIds: [...(target.pluginIds ?? [])],
      },
    ]),
  );

  if (!extensionsDir || !pathExists(extensionsDir)) {
    return [...deps.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  }

  for (const entry of readDir(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const pluginId = entry.name;
    const packageJsonPath = join(extensionsDir, pluginId, "package.json");
    if (!pathExists(packageJsonPath)) {
      continue;
    }
    try {
      const packageJson = readJsonFile(packageJsonPath);
      for (const [name, version] of Object.entries(collectRuntimeDeps(packageJson))) {
        const existing = deps.get(name);
        if (existing) {
          if (existing.version !== version) {
            continue;
          }
          if (!existing.pluginIds.includes(pluginId)) {
            existing.pluginIds.push(pluginId);
          }
          continue;
        }
        deps.set(name, {
          name,
          version,
          sentinelPath: dependencySentinelPath(name),
          pluginIds: [pluginId],
        });
      }
    } catch {
      // Ignore malformed plugin manifests; runtime will surface those separately.
    }
  }

  return [...deps.values()]
    .map((dep) => ({
      ...dep,
      pluginIds: [...dep.pluginIds].toSorted((a, b) => a.localeCompare(b)),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

export function createNestedNpmInstallEnv(env = process.env) {
  const nextEnv = { ...env };
  delete nextEnv.npm_config_global;
  delete nextEnv.npm_config_prefix;
  return nextEnv;
}

function buildNpmInstallCommand(missingSpecs) {
  // "Fix items" in order (Polytropos-owned list; keep it easy to extend):
  //  1) omit dev deps (runtime-only)
  //  2) avoid mutating package.json
  //  3) tolerate legacy peer dep graphs across bundled plugins
  //  4) avoid writing package-lock.json
  const fixArgs = ["--omit=dev", "--no-save", "--legacy-peer-deps", "--package-lock=false"];
  return `npm install ${fixArgs.join(" ")} ${missingSpecs.join(" ")}`;
}

export function runBundledPluginDepsHelper(params = {}) {
  const env = params.env ?? process.env;
  const packageRoot = params.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const extensionsDir = params.extensionsDir ?? join(packageRoot, "dist", "extensions");
  const exec = params.execSync ?? execSync;
  const pathExists = params.existsSync ?? existsSync;
  const log = params.log ?? console;
  // NOTE: The upstream helper only runs under `npm install -g` (it checks `npm_config_global`).
  // Polytropos invokes this helper explicitly in release tooling, so it must be reliable in non-global
  // shells as well. Keep `--allow-non-global` as a compatibility no-op for callers that still pass it.

  const runtimeDeps =
    params.runtimeDeps ??
    discoverBundledPluginRuntimeDeps({ extensionsDir, existsSync: pathExists });
  const missingSpecs = runtimeDeps
    .filter((dep) => !pathExists(join(packageRoot, dep.sentinelPath)))
    .map((dep) => `${dep.name}@${dep.version}`);

  if (missingSpecs.length === 0) {
    return;
  }

  try {
    exec(buildNpmInstallCommand(missingSpecs), {
      cwd: packageRoot,
      env: createNestedNpmInstallEnv(env),
      stdio: "pipe",
    });
    log.log(`[postinstall] installed bundled plugin deps: ${missingSpecs.join(", ")}`);
  } catch (e) {
    // Non-fatal: gateway will surface the missing dep via doctor.
    log.warn(`[postinstall] could not install bundled plugin deps: ${String(e)}`);
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let packageRoot = null;
  let extensionsDir = null;
  let allowNonGlobal = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--package-root") {
      packageRoot = args[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (a === "--extensions-dir") {
      extensionsDir = args[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (a === "--allow-non-global") {
      allowNonGlobal = true;
      continue;
    }
    if (a === "--help" || a === "-h") {
      return { cmd: "--help" };
    }
    throw new Error(`unknown argument: ${a}`);
  }
  return {
    cmd: "run",
    packageRoot: packageRoot ? resolve(packageRoot) : null,
    extensionsDir: extensionsDir ? resolve(extensionsDir) : null,
    allowNonGlobal,
  };
}

function usage() {
  // Keep it minimal: this script is meant to be invoked by release tooling.
  console.log(`polytropos-bundled-plugin-deps-helper.mjs

Usage:
  node scripts/polytropos-bundled-plugin-deps-helper.mjs [--package-root <root>] [--extensions-dir <dir>] [--allow-non-global]
`);
}

function isDirectInvocation(metaUrl, argv) {
  const argv1 = argv[1];
  if (!argv1) {
    return false;
  }
  const candidates = new Set();
  try {
    candidates.add(pathToFileURL(resolve(argv1)).href);
  } catch {
    // ignore
  }
  try {
    candidates.add(pathToFileURL(realpathSync(argv1)).href);
  } catch {
    // ignore
  }
  try {
    candidates.add(pathToFileURL(realpathSync(resolve(argv1))).href);
  } catch {
    // ignore
  }
  return candidates.has(metaUrl);
}

if (isDirectInvocation(import.meta.url, process.argv)) {
  const parsed = parseArgs(process.argv);
  if (parsed.cmd === "--help") {
    usage();
    process.exit(0);
  }
  runBundledPluginDepsHelper({
    packageRoot: parsed.packageRoot,
    extensionsDir: parsed.extensionsDir,
    allowNonGlobal: parsed.allowNonGlobal,
  });
}
