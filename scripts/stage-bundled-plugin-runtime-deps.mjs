import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import semverSatisfies from "semver/functions/satisfies.js";
import { resolveNpmRunner } from "./npm-runner.mjs";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function removePathIfExists(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function makeTempDir(parentDir, prefix) {
  return fs.mkdtempSync(path.join(parentDir, prefix));
}

function sanitizeTempPrefixSegment(value) {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-");
  return normalized.length > 0 ? normalized : "plugin";
}

function replaceDir(targetPath, sourcePath) {
  removePathIfExists(targetPath);
  try {
    fs.renameSync(sourcePath, targetPath);
    return;
  } catch (error) {
    if (error?.code !== "EXDEV") {
      throw error;
    }
  }
  fs.cpSync(sourcePath, targetPath, { recursive: true, force: true });
  removePathIfExists(sourcePath);
}

function dependencyNodeModulesPath(nodeModulesDir, depName) {
  return path.join(nodeModulesDir, ...depName.split("/"));
}

function readInstalledDependencyVersion(nodeModulesDir, depName) {
  const packageJsonPath = path.join(
    dependencyNodeModulesPath(nodeModulesDir, depName),
    "package.json",
  );
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }
  const version = readJson(packageJsonPath).version;
  return typeof version === "string" ? version : null;
}

function dependencyVersionSatisfied(spec, installedVersion) {
  return semverSatisfies(installedVersion, spec, { includePrerelease: false });
}

const stagedRuntimeDepPruneRules = new Map([
  // Type declarations only; runtime resolves through lib/es entrypoints.
  ["@larksuiteoapi/node-sdk", ["types"]],
]);
const runtimeDepsStagingVersion = 2;

function collectInstalledRuntimeClosure(rootNodeModulesDir, dependencySpecs) {
  const packageCache = new Map();
  const closure = new Set();
  const queue = Object.entries(dependencySpecs);

  while (queue.length > 0) {
    const [depName, spec] = queue.shift();
    const installedVersion = readInstalledDependencyVersion(rootNodeModulesDir, depName);
    if (installedVersion === null || !dependencyVersionSatisfied(spec, installedVersion)) {
      return null;
    }
    if (closure.has(depName)) {
      continue;
    }

    const packageJsonPath = path.join(
      dependencyNodeModulesPath(rootNodeModulesDir, depName),
      "package.json",
    );
    const packageJson = packageCache.get(depName) ?? readJson(packageJsonPath);
    packageCache.set(depName, packageJson);
    closure.add(depName);

    for (const [childName, childSpec] of Object.entries(packageJson.dependencies ?? {})) {
      queue.push([childName, childSpec]);
    }
    for (const [childName, childSpec] of Object.entries(packageJson.optionalDependencies ?? {})) {
      queue.push([childName, childSpec]);
    }
  }

  return [...closure];
}

function pruneStagedInstalledDependencyCargo(nodeModulesDir, depName) {
  const prunePaths = stagedRuntimeDepPruneRules.get(depName);
  if (!prunePaths) {
    return;
  }
  const depRoot = dependencyNodeModulesPath(nodeModulesDir, depName);
  for (const relativePath of prunePaths) {
    removePathIfExists(path.join(depRoot, relativePath));
  }
}

function pruneStagedRuntimeDependencyCargo(nodeModulesDir) {
  for (const depName of stagedRuntimeDepPruneRules.keys()) {
    pruneStagedInstalledDependencyCargo(nodeModulesDir, depName);
  }
}

function listBundledPluginRuntimeDirs(repoRoot) {
  const extensionsRoot = path.join(repoRoot, "dist", "extensions");
  if (!fs.existsSync(extensionsRoot)) {
    return [];
  }

  return fs
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => path.join(extensionsRoot, dirent.name))
    .filter((pluginDir) => fs.existsSync(path.join(pluginDir, "package.json")));
}

function hasRuntimeDeps(packageJson) {
  return (
    Object.keys(packageJson.dependencies ?? {}).length > 0 ||
    Object.keys(packageJson.optionalDependencies ?? {}).length > 0
  );
}

function shouldStageRuntimeDeps(packageJson) {
  return packageJson.openclaw?.bundle?.stageRuntimeDependencies === true;
}

function removeSanitizedDependencyEntries(entries, shouldRemove) {
  if (!entries || typeof entries !== "object") {
    return { changed: false, nextEntries: entries };
  }

  const nextEntries = Object.fromEntries(
    Object.entries(entries).filter(([depName, spec]) => !shouldRemove(depName, spec)),
  );
  const changed = Object.keys(nextEntries).length !== Object.keys(entries).length;
  return {
    changed,
    nextEntries: changed
      ? Object.keys(nextEntries).length > 0
        ? nextEntries
        : undefined
      : entries,
  };
}

function shouldRemoveLocalWorkspaceDependency(depName, spec) {
  return depName === "openclaw" || (typeof spec === "string" && spec.startsWith("workspace:"));
}

function sanitizeBundledManifestForRuntimeInstall(pluginDir) {
  const manifestPath = path.join(pluginDir, "package.json");
  const packageJson = readJson(manifestPath);
  let changed = false;

  const { changed: peerDependenciesChanged, nextEntries: nextPeerDependencies } =
    removeSanitizedDependencyEntries(
      packageJson.peerDependencies,
      shouldRemoveLocalWorkspaceDependency,
    );
  if (peerDependenciesChanged) {
    if (nextPeerDependencies) {
      packageJson.peerDependencies = nextPeerDependencies;
    } else {
      delete packageJson.peerDependencies;
    }
    changed = true;
  }

  if (peerDependenciesChanged && packageJson.peerDependenciesMeta) {
    const allowedPeerNames = new Set(Object.keys(packageJson.peerDependencies ?? {}));
    const nextPeerDependenciesMeta = Object.fromEntries(
      Object.entries(packageJson.peerDependenciesMeta).filter(([depName]) =>
        allowedPeerNames.has(depName),
      ),
    );
    if (Object.keys(nextPeerDependenciesMeta).length === 0) {
      delete packageJson.peerDependenciesMeta;
    } else {
      packageJson.peerDependenciesMeta = nextPeerDependenciesMeta;
    }
    changed = true;
  }

  if (packageJson.devDependencies) {
    delete packageJson.devDependencies;
    changed = true;
  }

  if (changed) {
    writeJson(manifestPath, packageJson);
  }

  return packageJson;
}

function resolveRuntimeDepsStampPath(pluginDir) {
  return path.join(pluginDir, ".openclaw-runtime-deps-stamp.json");
}

function createRuntimeDepsFingerprint(packageJson) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        packageJson,
        pruneRules: [...stagedRuntimeDepPruneRules.entries()],
        version: runtimeDepsStagingVersion,
      }),
    )
    .digest("hex");
}

function readRuntimeDepsStamp(stampPath) {
  if (!fs.existsSync(stampPath)) {
    return null;
  }
  try {
    return readJson(stampPath);
  } catch {
    return null;
  }
}

function stageInstalledRootRuntimeDeps(params) {
  const { fingerprint, packageJson, pluginDir, repoRoot } = params;
  const dependencySpecs = {
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
  };
  const rootNodeModulesDir = path.join(repoRoot, "node_modules");
  if (Object.keys(dependencySpecs).length === 0 || !fs.existsSync(rootNodeModulesDir)) {
    return false;
  }

  const dependencyNames = collectInstalledRuntimeClosure(rootNodeModulesDir, dependencySpecs);
  if (dependencyNames === null) {
    return false;
  }

  const nodeModulesDir = path.join(pluginDir, "node_modules");
  const stampPath = resolveRuntimeDepsStampPath(pluginDir);
  const stagedNodeModulesDir = path.join(
    makeTempDir(
      os.tmpdir(),
      `openclaw-runtime-deps-${sanitizeTempPrefixSegment(path.basename(pluginDir))}-`,
    ),
    "node_modules",
  );

  try {
    for (const depName of dependencyNames) {
      const sourcePath = dependencyNodeModulesPath(rootNodeModulesDir, depName);
      const targetPath = dependencyNodeModulesPath(stagedNodeModulesDir, depName);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.cpSync(sourcePath, targetPath, { recursive: true, force: true, dereference: true });
    }
    pruneStagedRuntimeDependencyCargo(stagedNodeModulesDir);

    replaceDir(nodeModulesDir, stagedNodeModulesDir);
    writeJson(stampPath, {
      fingerprint,
      generatedAt: new Date().toISOString(),
    });
    return true;
  } finally {
    removePathIfExists(path.dirname(stagedNodeModulesDir));
  }
}

function installPluginRuntimeDeps(params) {
  const { fingerprint, packageJson, pluginDir, pluginId, repoRoot } = params;
  if (
    repoRoot &&
    stageInstalledRootRuntimeDeps({ fingerprint, packageJson, pluginDir, repoRoot })
  ) {
    return;
  }
  const nodeModulesDir = path.join(pluginDir, "node_modules");
  const stampPath = resolveRuntimeDepsStampPath(pluginDir);
  const tempInstallDir = makeTempDir(
    os.tmpdir(),
    `openclaw-runtime-deps-${sanitizeTempPrefixSegment(pluginId)}-`,
  );
  const npmRunner = resolveNpmRunner({
    npmArgs: [
      "install",
      "--omit=dev",
      "--silent",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--package-lock=false",
    ],
  });
  try {
    writeJson(path.join(tempInstallDir, "package.json"), packageJson);
    const result = spawnSync(npmRunner.command, npmRunner.args, {
      cwd: tempInstallDir,
      encoding: "utf8",
      env: npmRunner.env,
      stdio: "pipe",
      shell: npmRunner.shell,
      windowsVerbatimArguments: npmRunner.windowsVerbatimArguments,
    });
    if (result.status !== 0) {
      const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      throw new Error(
        `failed to stage bundled runtime deps for ${pluginId}: ${output || "npm install failed"}`,
      );
    }

    const stagedNodeModulesDir = path.join(tempInstallDir, "node_modules");
    if (!fs.existsSync(stagedNodeModulesDir)) {
      throw new Error(
        `failed to stage bundled runtime deps for ${pluginId}: npm install produced no node_modules directory`,
      );
    }

    pruneStagedRuntimeDependencyCargo(stagedNodeModulesDir);

    replaceDir(nodeModulesDir, stagedNodeModulesDir);
    writeJson(stampPath, {
      fingerprint,
      generatedAt: new Date().toISOString(),
    });
  } finally {
    removePathIfExists(tempInstallDir);
  }
}

function installPluginRuntimeDepsWithRetries(params) {
  const { attempts = 3 } = params;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      params.install({ ...params.installParams, attempt });
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        break;
      }
    }
  }
  throw lastError;
}

export function stageBundledPluginRuntimeDeps(params = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const installPluginRuntimeDepsImpl =
    params.installPluginRuntimeDepsImpl ?? installPluginRuntimeDeps;
  const installAttempts = params.installAttempts ?? 3;
  for (const pluginDir of listBundledPluginRuntimeDirs(repoRoot)) {
    const pluginId = path.basename(pluginDir);
    const packageJson = sanitizeBundledManifestForRuntimeInstall(pluginDir);
    const nodeModulesDir = path.join(pluginDir, "node_modules");
    const stampPath = resolveRuntimeDepsStampPath(pluginDir);
    if (!hasRuntimeDeps(packageJson) || !shouldStageRuntimeDeps(packageJson)) {
      removePathIfExists(nodeModulesDir);
      removePathIfExists(stampPath);
      continue;
    }
    const fingerprint = createRuntimeDepsFingerprint(packageJson);
    const stamp = readRuntimeDepsStamp(stampPath);
    if (fs.existsSync(nodeModulesDir) && stamp?.fingerprint === fingerprint) {
      continue;
    }
    installPluginRuntimeDepsWithRetries({
      attempts: installAttempts,
      install: installPluginRuntimeDepsImpl,
      installParams: {
        fingerprint,
        packageJson,
        pluginDir,
        pluginId,
        repoRoot,
      },
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  stageBundledPluginRuntimeDeps();
}
