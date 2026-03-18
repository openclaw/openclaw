import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { removePathIfExists } from "./runtime-postbuild-shared.mjs";

function symlinkType() {
  return process.platform === "win32" ? "junction" : "dir";
}

function relativeSymlinkTarget(sourcePath, targetPath) {
  const relativeTarget = path.relative(path.dirname(targetPath), sourcePath);
  return relativeTarget || ".";
}

function symlinkPath(sourcePath, targetPath, type) {
  const target = type === "junction" ? sourcePath : relativeSymlinkTarget(sourcePath, targetPath);
  fs.symlinkSync(target, targetPath, type);
}

function isSymlinkPermissionError(error) {
  return (
    process.platform === "win32" &&
    (error?.code === "EPERM" || error?.code === "EACCES" || error?.code === "UNKNOWN")
  );
}

function copyPathFallback(sourcePath, targetPath) {
  const sourceStat = fs.statSync(sourcePath);
  if (sourceStat.isDirectory()) {
    fs.cpSync(sourcePath, targetPath, { recursive: true, force: true, dereference: true });
    return;
  }
  fs.copyFileSync(sourcePath, targetPath);
}

function symlinkPathWithFallback(sourcePath, targetPath, type) {
  try {
    symlinkPath(sourcePath, targetPath, type);
  } catch (error) {
    if (error?.code === "EEXIST") {
      removePathIfExists(targetPath);
      try {
        symlinkPath(sourcePath, targetPath, type);
        return;
      } catch (retryError) {
        if (!isSymlinkPermissionError(retryError)) {
          throw retryError;
        }
        copyPathFallback(sourcePath, targetPath);
        return;
      }
    }
    if (!isSymlinkPermissionError(error)) {
      throw error;
    }
    copyPathFallback(sourcePath, targetPath);
  }
}

function cloneSymlinkWithFallback(sourcePath, targetPath) {
  const linkTarget = fs.readlinkSync(sourcePath);
  try {
    fs.symlinkSync(linkTarget, targetPath);
  } catch (error) {
    if (!isSymlinkPermissionError(error)) {
      throw error;
    }
    const resolvedSourcePath = path.resolve(path.dirname(sourcePath), linkTarget);
    copyPathFallback(resolvedSourcePath, targetPath);
  }
}

function shouldWrapRuntimeJsFile(sourcePath) {
  return path.extname(sourcePath) === ".js";
}

function shouldCopyRuntimeFile(sourcePath) {
  const relativePath = sourcePath.replace(/\\/g, "/");
  return (
    relativePath.endsWith("/package.json") ||
    relativePath.endsWith("/openclaw.plugin.json") ||
    relativePath.endsWith("/.codex-plugin/plugin.json") ||
    relativePath.endsWith("/.claude-plugin/plugin.json") ||
    relativePath.endsWith("/.cursor-plugin/plugin.json")
  );
}

function writeRuntimeModuleWrapper(sourcePath, targetPath) {
  const specifier = relativeSymlinkTarget(sourcePath, targetPath).replace(/\\/g, "/");
  const normalizedSpecifier = specifier.startsWith(".") ? specifier : `./${specifier}`;
  fs.writeFileSync(
    targetPath,
    [
      `export * from ${JSON.stringify(normalizedSpecifier)};`,
      `import * as module from ${JSON.stringify(normalizedSpecifier)};`,
      "export default module.default;",
      "",
    ].join("\n"),
    "utf8",
  );
}

function stagePluginRuntimeOverlay(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });

  for (const dirent of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (dirent.name === "node_modules") {
      continue;
    }

    const sourcePath = path.join(sourceDir, dirent.name);
    const targetPath = path.join(targetDir, dirent.name);

    if (dirent.isDirectory()) {
      stagePluginRuntimeOverlay(sourcePath, targetPath);
      continue;
    }

    if (dirent.isSymbolicLink()) {
      cloneSymlinkWithFallback(sourcePath, targetPath);
      continue;
    }

    if (!dirent.isFile()) {
      continue;
    }

    if (shouldWrapRuntimeJsFile(sourcePath)) {
      writeRuntimeModuleWrapper(sourcePath, targetPath);
      continue;
    }

    if (shouldCopyRuntimeFile(sourcePath)) {
      fs.copyFileSync(sourcePath, targetPath);
      continue;
    }

    symlinkPathWithFallback(sourcePath, targetPath);
  }
}

function linkPluginNodeModules(params) {
  const runtimeNodeModulesDir = path.join(params.runtimePluginDir, "node_modules");
  removePathIfExists(runtimeNodeModulesDir);
  if (params.distPluginDir) {
    removePathIfExists(path.join(params.distPluginDir, "node_modules"));
  }
  if (!fs.existsSync(params.sourcePluginNodeModulesDir)) {
    return;
  }
  symlinkPathWithFallback(params.sourcePluginNodeModulesDir, runtimeNodeModulesDir, symlinkType());

  // Runtime wrappers re-export from dist/extensions/<plugin>/index.js, so Node
  // resolves bare-specifier dependencies relative to the dist plugin directory.
  // copy-bundled-plugin-metadata removes dist node_modules; restore the link here.
  if (params.distPluginDir) {
    removePathIfExists(path.join(params.distPluginDir, "node_modules"));
  }

  if (!fs.existsSync(params.sourcePluginNodeModulesDir)) {
    return;
  }



  if (params.distPluginDir) {
    const distNodeModulesDir = path.join(params.distPluginDir, "node_modules");
    symlinkPathWithFallback(params.sourcePluginNodeModulesDir, distNodeModulesDir, symlinkType());
  }
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
  fs.mkdirSync(runtimeExtensionsRoot, { recursive: true });

  for (const dirent of fs.readdirSync(distExtensionsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const distPluginDir = path.join(distExtensionsRoot, dirent.name);
    const runtimePluginDir = path.join(runtimeExtensionsRoot, dirent.name);
    const sourcePluginNodeModulesDir = path.join(sourceExtensionsRoot, dirent.name, "node_modules");

    stagePluginRuntimeOverlay(distPluginDir, runtimePluginDir);
    linkPluginNodeModules({
      runtimePluginDir,
      distPluginDir,
      sourcePluginNodeModulesDir,
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  stageBundledPluginRuntime();
}
