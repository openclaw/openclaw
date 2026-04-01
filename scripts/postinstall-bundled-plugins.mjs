#!/usr/bin/env node
// Runs after `npm i -g` to restore bundled extension runtime deps.
// Installed builds can lazy-load bundled plugin code through root dist chunks,
// so runtime dependencies declared in dist/extensions/*/package.json must also
// resolve from the package root node_modules after a global install.
// This script is a no-op outside of a global npm install context.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveNpmRunner } from "./npm-runner.mjs";

export const BUNDLED_PLUGIN_INSTALL_TARGETS = [];

function buildPluginSentinelPaths(pluginIds, depName) {
  return pluginIds
    .toSorted((a, b) => a.localeCompare(b))
    .map((pluginId) => ({
      pluginId,
      sentinelPath: pluginDependencySentinelPath(pluginId, depName),
    }));
}

function runtimeDepKey(name, version) {
  return `${name}\u0000${version}`;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXTENSIONS_DIR = join(__dirname, "..", "dist", "extensions");
const DEFAULT_PACKAGE_ROOT = join(__dirname, "..");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function dependencySentinelPath(depName) {
  return join("node_modules", ...depName.split("/"), "package.json");
}

function pluginDependencySentinelPath(pluginId, depName) {
  return join("dist", "extensions", pluginId, dependencySentinelPath(depName));
}

function collectRuntimeDeps(packageJson) {
  return {
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
  };
}

export function discoverBundledPluginRuntimeDeps(params = {}) {
  const extensionsDir = params.extensionsDir ?? DEFAULT_EXTENSIONS_DIR;
  const pathExists = params.existsSync ?? existsSync;
  const readDir = params.readdirSync ?? readdirSync;
  const readJsonFile = params.readJson ?? readJson;
  const deps = new Map(
    BUNDLED_PLUGIN_INSTALL_TARGETS.map((target) => [
      runtimeDepKey(target.name, target.version),
      {
        name: target.name,
        version: target.version,
        pluginIds: [...(target.pluginIds ?? [])],
        sentinelPath: dependencySentinelPath(target.name),
        sentinelPaths: buildPluginSentinelPaths(target.pluginIds ?? [], target.name),
      },
    ]),
  );

  if (!pathExists(extensionsDir)) {
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
        const key = runtimeDepKey(name, version);
        const existing = deps.get(key);
        if (existing) {
          if (!existing.pluginIds.includes(pluginId)) {
            existing.pluginIds.push(pluginId);
            existing.sentinelPaths = buildPluginSentinelPaths(existing.pluginIds, name);
          }
          continue;
        }
        deps.set(key, {
          name,
          version,
          sentinelPath: pluginDependencySentinelPath(pluginId, name),
          sentinelPaths: [{ pluginId, sentinelPath: pluginDependencySentinelPath(pluginId, name) }],
          pluginIds: [pluginId],
        });
      }
    } catch {
      // Ignore malformed plugin manifests; runtime will surface those separately.
    }
  }

  return [...deps.values()]
    .map((dep) => {
      const pluginIds = [...dep.pluginIds].toSorted((a, b) => a.localeCompare(b));
      return {
        ...dep,
        pluginIds,
        sentinelPath: pluginIds.length
          ? pluginDependencySentinelPath(pluginIds[0], dep.name)
          : dependencySentinelPath(dep.name),
        sentinelPaths: buildPluginSentinelPaths(pluginIds, dep.name),
      };
    })
    .toSorted((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

export function createNestedNpmInstallEnv(env = process.env) {
  const nextEnv = { ...env };
  delete nextEnv.npm_config_global;
  delete nextEnv.npm_config_location;
  delete nextEnv.npm_config_prefix;
  return nextEnv;
}

function isGlobalNpmInstall(env) {
  if (env.npm_config_global === "true") {
    return true;
  }
  if (typeof env.npm_config_location === "string") {
    return env.npm_config_location.toLowerCase() === "global";
  }
  return false;
}

export function runBundledPluginPostinstall(params = {}) {
  const env = params.env ?? process.env;
  if (!isGlobalNpmInstall(env)) {
    return;
  }
  const extensionsDir = params.extensionsDir ?? DEFAULT_EXTENSIONS_DIR;
  const packageRoot = params.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const spawn = params.spawnSync ?? spawnSync;
  const pathExists = params.existsSync ?? existsSync;
  const log = params.log ?? console;
  const runtimeDeps =
    params.runtimeDeps ??
    discoverBundledPluginRuntimeDeps({ extensionsDir, existsSync: pathExists });

  const installsByDir = new Map();
  for (const dep of runtimeDeps) {
    const pluginIds = dep.pluginIds?.length ? dep.pluginIds : [];
    for (const pluginId of pluginIds) {
      const sentinelPath = pluginDependencySentinelPath(pluginId, dep.name);
      if (pathExists(join(packageRoot, sentinelPath))) {
        continue;
      }
      const installDir = join(extensionsDir, pluginId);
      const existing = installsByDir.get(installDir) ?? { pluginId, specs: [] };
      existing.specs.push(`${dep.name}@${dep.version}`);
      installsByDir.set(installDir, existing);
    }
  }

  if (installsByDir.size === 0) {
    return;
  }

  const nestedEnv = createNestedNpmInstallEnv(env);
  for (const [installDir, install] of installsByDir) {
    try {
      const npmRunner =
        params.npmRunner ??
        resolveNpmRunner({
          env: nestedEnv,
          execPath: params.execPath,
          existsSync: pathExists,
          platform: params.platform,
          comSpec: params.comSpec,
          npmArgs: ["install", "--omit=dev", "--no-save", "--package-lock=false", ...install.specs],
        });
      const result = spawn(npmRunner.command, npmRunner.args, {
        cwd: installDir,
        encoding: "utf8",
        env: npmRunner.env ?? nestedEnv,
        stdio: "pipe",
        shell: npmRunner.shell,
        windowsVerbatimArguments: npmRunner.windowsVerbatimArguments,
      });
      if (result.status !== 0) {
        const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
        throw new Error(output || "npm install failed");
      }
      log.log(
        `[postinstall] installed bundled plugin deps for ${install.pluginId}: ${install.specs.join(", ")}`,
      );
    } catch (e) {
      // Non-fatal: gateway will surface the missing dep via doctor.
      log.warn(
        `[postinstall] could not install bundled plugin deps for ${install.pluginId}: ${String(e)}`,
      );
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runBundledPluginPostinstall();
}
