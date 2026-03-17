import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { removePathIfExists } from "./runtime-postbuild-shared.mjs";

const RUNTIME_COPY_MANIFESTS = [
  {
    manifestRelativePath: "openclaw.plugin.json",
    resolvePaths(manifest) {
      return normalizePathList(manifest.skills);
    },
  },
  {
    manifestRelativePath: ".codex-plugin/plugin.json",
    resolvePaths(manifest, sourceDir) {
      const declaredSkills = normalizePathList(manifest.skills);
      return declaredSkills.length > 0
        ? declaredSkills
        : defaultExistingPaths(sourceDir, ["skills"]);
    },
  },
  {
    manifestRelativePath: ".claude-plugin/plugin.json",
    resolvePaths(manifest, sourceDir) {
      return mergePathLists(
        normalizePathList(manifest.skills),
        normalizePathList(manifest.commands),
        defaultExistingPaths(sourceDir, ["skills", "commands"]),
      );
    },
  },
  {
    manifestRelativePath: ".cursor-plugin/plugin.json",
    resolvePaths(manifest, sourceDir) {
      return mergePathLists(
        defaultExistingPaths(sourceDir, ["skills", ".cursor/commands"]),
        normalizePathList(manifest.skills),
        normalizePathList(manifest.commands),
      );
    },
  },
];

const RUNTIME_METADATA_COPY_PATHS = [
  "package.json",
  ...RUNTIME_COPY_MANIFESTS.map((entry) => entry.manifestRelativePath),
];

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

function isPathInside(rootDir, candidatePath) {
  const relative = path.relative(rootDir, candidatePath);
  return (
    relative === "" ||
    relative === "." ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function ensurePathInsideRoot(rootDir, rawPath) {
  const resolved = path.resolve(rootDir, rawPath);
  if (isPathInside(rootDir, resolved)) {
    return resolved;
  }
  throw new Error(`path escapes plugin root: ${rawPath}`);
}

function ensureRealPathInsideRoot(rootRealDir, candidatePath, rawPath = candidatePath) {
  const resolvedRealPath = fs.realpathSync(candidatePath);
  if (isPathInside(rootRealDir, resolvedRealPath)) {
    return resolvedRealPath;
  }
  throw new Error(`path escapes plugin root via symlink: ${rawPath}`);
}

function readJsonFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse manifest JSON at ${filePath}`);
  }
}

function defaultExistingPaths(sourceDir, paths) {
  return paths.filter((relativePath) => fs.existsSync(path.join(sourceDir, relativePath)));
}

function resolveDeclaredRuntimeCopyPaths(sourceDir, sourceRealDir) {
  const resolved = [];
  const addPaths = (rawPaths) => {
    for (const rawPath of rawPaths) {
      const sourcePath = ensurePathInsideRoot(sourceDir, rawPath);
      if (!fs.existsSync(sourcePath)) {
        continue;
      }
      ensureRealPathInsideRoot(sourceRealDir, sourcePath, rawPath);
      const relativePath = normalizeManifestPath(path.relative(sourceDir, sourcePath));
      if (relativePath) {
        resolved.push(relativePath);
      }
    }
  };

  for (const entry of RUNTIME_COPY_MANIFESTS) {
    const manifest = readJsonFileIfExists(path.join(sourceDir, entry.manifestRelativePath));
    if (!manifest || typeof manifest !== "object") {
      continue;
    }
    addPaths(entry.resolvePaths(manifest, sourceDir));
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

function hasRuntimeMetadataCopySuffix(sourcePath, relativePath) {
  const normalizedSourcePath = sourcePath.replace(/\\/g, "/");
  return normalizedSourcePath === relativePath || normalizedSourcePath.endsWith(`/${relativePath}`);
}

function shouldCopyRuntimeFile(sourcePath) {
  return RUNTIME_METADATA_COPY_PATHS.some((relativePath) =>
    hasRuntimeMetadataCopySuffix(sourcePath, relativePath),
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

function copyRuntimeOverlayPath(sourcePath, targetPath, options) {
  fs.cpSync(sourcePath, targetPath, {
    dereference: true,
    force: true,
    recursive: true,
    filter(candidatePath) {
      const displayPath =
        normalizeManifestPath(path.relative(options.pluginRootDir, candidatePath)) || candidatePath;
      ensureRealPathInsideRoot(options.pluginRootRealDir, candidatePath, displayPath);
      return true;
    },
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
      copyRuntimeOverlayPath(sourcePath, targetPath, options);
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
    const distPluginRealDir = fs.realpathSync(distPluginDir);
    const runtimePluginDir = path.join(runtimeExtensionsRoot, dirent.name);
    const sourcePluginNodeModulesDir = path.join(sourceExtensionsRoot, dirent.name, "node_modules");
    const copiedPaths = resolveDeclaredRuntimeCopyPaths(distPluginDir, distPluginRealDir);

    stagePluginRuntimeOverlay(distPluginDir, runtimePluginDir, {
      copiedPaths,
      pluginRootDir: distPluginDir,
      pluginRootRealDir: distPluginRealDir,
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
