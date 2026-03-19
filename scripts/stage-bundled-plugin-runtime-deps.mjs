import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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

function installPluginRuntimeDeps(pluginDir, pluginId) {
  const result = spawnSync(
    "npm",
    ["install", "--omit=dev", "--silent", "--ignore-scripts", "--package-lock=false"],
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
