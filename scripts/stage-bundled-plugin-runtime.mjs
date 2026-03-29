import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { removePathIfExists } from "./runtime-postbuild-shared.mjs";

function symlinkType(platform = process.platform) {
  return platform === "win32" ? "junction" : "dir";
}

function relativeSymlinkTarget(sourcePath, targetPath) {
  const relativeTarget = path.relative(path.dirname(targetPath), sourcePath);
  return relativeTarget || ".";
}

function copyRuntimeOverlayFile(sourcePath, targetPath, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(targetPath), { recursive: true });
  fsImpl.copyFileSync(sourcePath, targetPath);
}

function shouldCopyInsteadOfSymlink({ error, fsImpl = fs, platform = process.platform, sourcePath, type }) {
  if (platform !== "win32" || !sourcePath || type === "dir" || type === "junction") {
    return false;
  }
  if (!["EPERM", "EACCES"].includes(error?.code ?? "")) {
    return false;
  }
  try {
    return fsImpl.statSync(sourcePath).isFile();
  } catch {
    return false;
  }
}

function ensureSymlink(targetValue, targetPath, type, options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  const platform = options.platform ?? process.platform;
  try {
    fsImpl.symlinkSync(targetValue, targetPath, type);
    return;
  } catch (error) {
    if (shouldCopyInsteadOfSymlink({ error, fsImpl, platform, sourcePath: options.sourcePath, type })) {
      copyRuntimeOverlayFile(options.sourcePath, targetPath, fsImpl);
      return;
    }
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }

  try {
    if (fsImpl.lstatSync(targetPath).isSymbolicLink() && fsImpl.readlinkSync(targetPath) === targetValue) {
      return;
    }
  } catch {
    // Fall through and recreate the target when inspection fails.
  }

  removePathIfExists(targetPath);
  try {
    fsImpl.symlinkSync(targetValue, targetPath, type);
  } catch (error) {
    if (shouldCopyInsteadOfSymlink({ error, fsImpl, platform, sourcePath: options.sourcePath, type })) {
      copyRuntimeOverlayFile(options.sourcePath, targetPath, fsImpl);
      return;
    }
    throw error;
  }
}

function symlinkPath(sourcePath, targetPath, type, options = {}) {
  ensureSymlink(relativeSymlinkTarget(sourcePath, targetPath), targetPath, type, {
    ...options,
    sourcePath,
  });
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

function stagePluginRuntimeOverlay(sourceDir, targetDir, options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  fsImpl.mkdirSync(targetDir, { recursive: true });

  for (const dirent of fsImpl.readdirSync(sourceDir, { withFileTypes: true })) {
    if (dirent.name === "node_modules") {
      continue;
    }

    const sourcePath = path.join(sourceDir, dirent.name);
    const targetPath = path.join(targetDir, dirent.name);

    if (dirent.isDirectory()) {
      stagePluginRuntimeOverlay(sourcePath, targetPath, options);
      continue;
    }

    if (dirent.isSymbolicLink()) {
      ensureSymlink(fsImpl.readlinkSync(sourcePath), targetPath, undefined, options);
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
      fsImpl.copyFileSync(sourcePath, targetPath);
      continue;
    }

    symlinkPath(sourcePath, targetPath, undefined, options);
  }
}

function linkPluginNodeModules(params) {
  const fsImpl = params.fsImpl ?? fs;
  const platform = params.platform ?? process.platform;
  const runtimeNodeModulesDir = path.join(params.runtimePluginDir, "node_modules");
  removePathIfExists(runtimeNodeModulesDir);
  if (!fsImpl.existsSync(params.sourcePluginNodeModulesDir)) {
    return;
  }
  ensureSymlink(params.sourcePluginNodeModulesDir, runtimeNodeModulesDir, symlinkType(platform), {
    fsImpl,
    platform,
  });
}

export function stageBundledPluginRuntime(params = {}) {
  const fsImpl = params.fsImpl ?? fs;
  const platform = params.platform ?? process.platform;
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const distRoot = path.join(repoRoot, "dist");
  const runtimeRoot = path.join(repoRoot, "dist-runtime");
  const distExtensionsRoot = path.join(distRoot, "extensions");
  const runtimeExtensionsRoot = path.join(runtimeRoot, "extensions");

  if (!fsImpl.existsSync(distExtensionsRoot)) {
    removePathIfExists(runtimeRoot);
    return;
  }

  removePathIfExists(runtimeRoot);
  fsImpl.mkdirSync(runtimeExtensionsRoot, { recursive: true });

  for (const dirent of fsImpl.readdirSync(distExtensionsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const distPluginDir = path.join(distExtensionsRoot, dirent.name);
    const runtimePluginDir = path.join(runtimeExtensionsRoot, dirent.name);
    const distPluginNodeModulesDir = path.join(distPluginDir, "node_modules");

    stagePluginRuntimeOverlay(distPluginDir, runtimePluginDir, { fsImpl, platform });
    linkPluginNodeModules({
      runtimePluginDir,
      sourcePluginNodeModulesDir: distPluginNodeModulesDir,
      fsImpl,
      platform,
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  stageBundledPluginRuntime();
}
