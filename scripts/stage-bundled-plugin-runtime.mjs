import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { removePathIfExists } from "./runtime-postbuild-shared.mjs";

function linkOrCopyFile(sourcePath, targetPath) {
  try {
    fs.linkSync(sourcePath, targetPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      const code = error.code;
      if (code === "EXDEV" || code === "EPERM" || code === "EMLINK") {
        fs.copyFileSync(sourcePath, targetPath);
        return;
      }
    }
    throw error;
  }
}

function mirrorTreeWithHardlinks(sourceRoot, targetRoot) {
  fs.mkdirSync(targetRoot, { recursive: true });
  const queue = [{ sourceDir: sourceRoot, targetDir: targetRoot }];

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }

    for (const dirent of fs.readdirSync(current.sourceDir, { withFileTypes: true })) {
      const sourcePath = path.join(current.sourceDir, dirent.name);
      const targetPath = path.join(current.targetDir, dirent.name);

      if (dirent.isDirectory()) {
        fs.mkdirSync(targetPath, { recursive: true });
        queue.push({ sourceDir: sourcePath, targetDir: targetPath });
        continue;
      }

      if (dirent.isSymbolicLink()) {
        fs.symlinkSync(fs.readlinkSync(sourcePath), targetPath);
        continue;
      }

      if (!dirent.isFile()) {
        continue;
      }

      linkOrCopyFile(sourcePath, targetPath);
    }
  }
}

function symlinkType() {
  return process.platform === "win32" ? "junction" : "dir";
}

function linkPluginNodeModules(params) {
  const runtimeNodeModulesDir = path.join(params.runtimePluginDir, "node_modules");
  removePathIfExists(runtimeNodeModulesDir);
  if (!fs.existsSync(params.sourcePluginNodeModulesDir)) {
    return;
  }
  fs.symlinkSync(params.sourcePluginNodeModulesDir, runtimeNodeModulesDir, symlinkType());
}

export function stageBundledPluginRuntime(params = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const distRoot = path.join(repoRoot, "dist");
  const runtimeRoot = path.join(repoRoot, "dist-runtime");
  const sourceExtensionsRoot = path.join(repoRoot, "extensions");
  const distExtensionsRoot = path.join(distRoot, "extensions");
  const runtimeExtensionsRoot = path.join(runtimeRoot, "extensions");

  if (!fs.existsSync(distExtensionsRoot)) {
    removePathIfExists(runtimeRoot);
    return;
  }

  removePathIfExists(runtimeRoot);
  mirrorTreeWithHardlinks(distRoot, runtimeRoot);

  for (const dirent of fs.readdirSync(distExtensionsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const runtimePluginDir = path.join(runtimeExtensionsRoot, dirent.name);
    const sourcePluginNodeModulesDir = path.join(sourceExtensionsRoot, dirent.name, "node_modules");

    linkPluginNodeModules({
      runtimePluginDir,
      sourcePluginNodeModulesDir,
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  stageBundledPluginRuntime();
}
