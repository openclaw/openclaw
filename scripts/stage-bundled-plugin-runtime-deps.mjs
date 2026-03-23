import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function removePathIfExists(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
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

function sanitizeBundledManifestForRuntimeInstall(pluginDir) {
  const manifestPath = path.join(pluginDir, "package.json");
  const packageJson = readJson(manifestPath);
  let changed = false;

  if (packageJson.peerDependencies?.openclaw) {
    const nextPeerDependencies = { ...packageJson.peerDependencies };
    delete nextPeerDependencies.openclaw;
    if (Object.keys(nextPeerDependencies).length === 0) {
      delete packageJson.peerDependencies;
    } else {
      packageJson.peerDependencies = nextPeerDependencies;
    }
    changed = true;
  }

  if (packageJson.peerDependenciesMeta?.openclaw) {
    const nextPeerDependenciesMeta = { ...packageJson.peerDependenciesMeta };
    delete nextPeerDependenciesMeta.openclaw;
    if (Object.keys(nextPeerDependenciesMeta).length === 0) {
      delete packageJson.peerDependenciesMeta;
    } else {
      packageJson.peerDependenciesMeta = nextPeerDependenciesMeta;
    }
    changed = true;
  }

  if (packageJson.devDependencies?.openclaw) {
    const nextDevDependencies = { ...packageJson.devDependencies };
    delete nextDevDependencies.openclaw;
    if (Object.keys(nextDevDependencies).length === 0) {
      delete packageJson.devDependencies;
    } else {
      packageJson.devDependencies = nextDevDependencies;
    }
    changed = true;
  }

  if (changed) {
    writeJson(manifestPath, packageJson);
  }
}

function installPluginRuntimeDeps(pluginDir, pluginId) {
  sanitizeBundledManifestForRuntimeInstall(pluginDir);
  const result = spawnSync(
    "npm",
    [
      "install",
      "--omit=dev",
      "--silent",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--package-lock=false",
    ],
    {
      cwd: pluginDir,
      encoding: "utf8",
      stdio: "pipe",
      shell: process.platform === "win32",
    },
  );
  if (result.status === 0) {
    return;
  }
  const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
  throw new Error(
    `failed to stage bundled runtime deps for ${pluginId}: ${output || "npm install failed"}`,
  );
}

export function stageBundledPluginRuntimeDeps(params = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  for (const pluginDir of listBundledPluginRuntimeDirs(repoRoot)) {
    const pluginId = path.basename(pluginDir);
    const packageJson = readJson(path.join(pluginDir, "package.json"));
    const nodeModulesDir = path.join(pluginDir, "node_modules");
    removePathIfExists(nodeModulesDir);
    if (!hasRuntimeDeps(packageJson) || !shouldStageRuntimeDeps(packageJson)) {
      continue;
    }
    installPluginRuntimeDeps(pluginDir, pluginId);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  stageBundledPluginRuntimeDeps();
}
