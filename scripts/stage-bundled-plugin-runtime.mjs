import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { removePathIfExists } from "./runtime-postbuild-shared.mjs";

const CODEX_BUNDLE_MANIFEST = ".codex-plugin/plugin.json";
const CLAUDE_BUNDLE_MANIFEST = ".claude-plugin/plugin.json";
const CURSOR_BUNDLE_MANIFEST = ".cursor-plugin/plugin.json";

function symlinkType() {
  return process.platform === "win32" ? "junction" : "dir";
}

function relativeSymlinkTarget(sourcePath, targetPath) {
  const relativeTarget = path.relative(path.dirname(targetPath), sourcePath);
  return relativeTarget || ".";
}

function symlinkPath(sourcePath, targetPath, type) {
  fs.symlinkSync(relativeSymlinkTarget(sourcePath, targetPath), targetPath, type);
}

function normalizeManifestPath(rawPath) {
  return rawPath.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
}

function normalizePathList(value) {
  if (typeof value === "string") {
    const normalized = normalizeManifestPath(value.trim());
    return normalized ? [normalized] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? normalizeManifestPath(entry.trim()) : ""))
    .filter(Boolean);
}

function mergePathLists(...groups) {
  const merged = [];
  const seen = new Set();
  for (const group of groups) {
    for (const entry of group) {
      if (seen.has(entry)) {
        continue;
      }
      seen.add(entry);
      merged.push(entry);
    }
  }
  return merged;
}

function ensurePathInsideRoot(rootDir, rawPath) {
  const resolved = path.resolve(rootDir, rawPath);
  const relative = path.relative(rootDir, resolved);
  if (
    relative === "" ||
    relative === "." ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    return resolved;
  }
  throw new Error(`path escapes plugin root: ${rawPath}`);
}

function readJsonFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function defaultExistingPaths(sourceDir, paths) {
  return paths.filter((relativePath) => fs.existsSync(path.join(sourceDir, relativePath)));
}

function resolveDeclaredRuntimeCopyPaths(sourceDir) {
  const resolved = [];
  const addPaths = (rawPaths) => {
    for (const rawPath of rawPaths) {
      const sourcePath = ensurePathInsideRoot(sourceDir, rawPath);
      if (!fs.existsSync(sourcePath)) {
        continue;
      }
      const relativePath = normalizeManifestPath(path.relative(sourceDir, sourcePath));
      if (relativePath) {
        resolved.push(relativePath);
      }
    }
  };

  const pluginManifest = readJsonFileIfExists(path.join(sourceDir, "openclaw.plugin.json"));
  if (pluginManifest && typeof pluginManifest === "object") {
    addPaths(normalizePathList(pluginManifest.skills));
  }

  const codexManifest = readJsonFileIfExists(path.join(sourceDir, CODEX_BUNDLE_MANIFEST));
  if (codexManifest && typeof codexManifest === "object") {
    addPaths(
      mergePathLists(
        normalizePathList(codexManifest.skills),
        defaultExistingPaths(sourceDir, ["skills"]),
      ),
    );
  }

  const claudeManifest = readJsonFileIfExists(path.join(sourceDir, CLAUDE_BUNDLE_MANIFEST));
  if (claudeManifest && typeof claudeManifest === "object") {
    addPaths(
      mergePathLists(
        normalizePathList(claudeManifest.skills),
        normalizePathList(claudeManifest.commands),
        defaultExistingPaths(sourceDir, ["skills", "commands"]),
      ),
    );
  }

  const cursorManifest = readJsonFileIfExists(path.join(sourceDir, CURSOR_BUNDLE_MANIFEST));
  if (cursorManifest && typeof cursorManifest === "object") {
    addPaths(
      mergePathLists(
        defaultExistingPaths(sourceDir, ["skills", ".cursor/commands"]),
        normalizePathList(cursorManifest.skills),
        normalizePathList(cursorManifest.commands),
      ),
    );
  }

  return new Set(resolved);
}

function shouldCopyDeclaredRuntimePath(relativePath, copiedPaths) {
  const normalizedPath = normalizeManifestPath(relativePath);
  if (!normalizedPath) {
    return false;
  }
  for (const copiedPath of copiedPaths) {
    if (normalizedPath === copiedPath || normalizedPath.startsWith(`${copiedPath}/`)) {
      return true;
    }
  }
  return false;
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

function copyRuntimeOverlayPath(sourcePath, targetPath) {
  fs.cpSync(sourcePath, targetPath, {
    dereference: true,
    force: true,
    recursive: true,
  });
}

function stagePluginRuntimeOverlay(sourceDir, targetDir, options) {
  fs.mkdirSync(targetDir, { recursive: true });

  for (const dirent of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (dirent.name === "node_modules") {
      continue;
    }

    const sourcePath = path.join(sourceDir, dirent.name);
    const targetPath = path.join(targetDir, dirent.name);
    const relativePath = path.relative(options.pluginRootDir, sourcePath);

    // Skill trees must stay physically inside dist-runtime so the realpath
    // containment checks still accept bundled plugin skills from the runtime root.
    if (shouldCopyDeclaredRuntimePath(relativePath, options.copiedPaths)) {
      copyRuntimeOverlayPath(sourcePath, targetPath);
      continue;
    }

    if (dirent.isDirectory()) {
      stagePluginRuntimeOverlay(sourcePath, targetPath, options);
      continue;
    }

    if (dirent.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(sourcePath), targetPath);
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

    symlinkPath(sourcePath, targetPath);
  }
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
  fs.mkdirSync(runtimeExtensionsRoot, { recursive: true });

  for (const dirent of fs.readdirSync(distExtensionsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const distPluginDir = path.join(distExtensionsRoot, dirent.name);
    const runtimePluginDir = path.join(runtimeExtensionsRoot, dirent.name);
    const sourcePluginNodeModulesDir = path.join(sourceExtensionsRoot, dirent.name, "node_modules");
    const copiedPaths = resolveDeclaredRuntimeCopyPaths(distPluginDir);

    stagePluginRuntimeOverlay(distPluginDir, runtimePluginDir, {
      copiedPaths,
      pluginRootDir: distPluginDir,
    });
    linkPluginNodeModules({
      runtimePluginDir,
      sourcePluginNodeModulesDir,
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  stageBundledPluginRuntime();
}
