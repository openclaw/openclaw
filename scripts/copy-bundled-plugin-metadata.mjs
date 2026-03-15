import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { removeFileIfExists, writeTextFileIfChanged } from "./runtime-postbuild-shared.mjs";

function rewritePackageExtensions(entries) {
  if (!Array.isArray(entries)) {
    return undefined;
  }

  return entries
    .filter((entry) => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => {
      const normalized = entry.replace(/^\.\//, "");
      const rewritten = normalized.replace(/\.[^.]+$/u, ".js");
      return `./${rewritten}`;
    });
}

export function copyBundledPluginMetadata(params = {}) {
  const repoRoot = params.cwd ?? process.cwd();
  const extensionsRoot = path.join(repoRoot, "extensions");
  const distExtensionsRoot = path.join(repoRoot, "dist", "extensions");
  if (!fs.existsSync(extensionsRoot)) {
    return;
  }

  const sourcePluginDirs = new Set();

  for (const dirent of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    sourcePluginDirs.add(dirent.name);

    const pluginDir = path.join(extensionsRoot, dirent.name);
    const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
    const distPluginDir = path.join(distExtensionsRoot, dirent.name);
    const distManifestPath = path.join(distPluginDir, "openclaw.plugin.json");
    const distPackageJsonPath = path.join(distPluginDir, "package.json");
    if (!fs.existsSync(manifestPath)) {
      removeFileIfExists(distManifestPath);
      removeFileIfExists(distPackageJsonPath);
      continue;
    }

    writeTextFileIfChanged(distManifestPath, fs.readFileSync(manifestPath, "utf8"));

    const packageJsonPath = path.join(pluginDir, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      removeFileIfExists(distPackageJsonPath);
      continue;
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    if (packageJson.openclaw && "extensions" in packageJson.openclaw) {
      packageJson.openclaw = {
        ...packageJson.openclaw,
        extensions: rewritePackageExtensions(packageJson.openclaw.extensions),
      };
    }

    writeTextFileIfChanged(distPackageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  }

  if (!fs.existsSync(distExtensionsRoot)) {
    return;
  }

  for (const dirent of fs.readdirSync(distExtensionsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory() || sourcePluginDirs.has(dirent.name)) {
      continue;
    }
    const distPluginDir = path.join(distExtensionsRoot, dirent.name);
    removeFileIfExists(path.join(distPluginDir, "openclaw.plugin.json"));
    removeFileIfExists(path.join(distPluginDir, "package.json"));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  copyBundledPluginMetadata();
}
