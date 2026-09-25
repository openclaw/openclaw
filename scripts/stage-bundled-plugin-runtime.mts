// Stages bundled plugin runtime overlays into dist-runtime with SDK aliases and
// Windows-safe symlink fallbacks.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { withDistArtifactOwnership } from "./lib/dist-artifact-ownership.mts";
import { assertRealOutputRoot } from "./lib/output-root-guard.mjs";
import { isRecord } from "./lib/record-shared.mjs";
import type { PrepareBundledPluginRuntime } from "./lib/runtime-artifact-contract.js";
import {
  copyStaticExtensionAssetsToRuntimeOverlay,
  shouldCopyStaticExtensionAssets,
} from "./lib/static-extension-assets.mts";
import { removePathIfExists } from "./runtime-postbuild-shared.mjs";

type SymlinkType = Parameters<typeof fs.symlinkSync>[2];
type PluginSdkFileParams = { pluginSdkDir: string; repoRoot: string };

function relativeSymlinkTarget(sourcePath: string, targetPath: string) {
  const relativeTarget = path.relative(path.dirname(targetPath), sourcePath);
  return relativeTarget || ".";
}

function shouldFallbackToCopy(error: unknown) {
  const code = isRecord(error) ? error.code : undefined;
  return (
    process.platform === "win32" &&
    (code === "EACCES" ||
      code === "EINVAL" ||
      code === "ENOSYS" ||
      code === "EPERM" ||
      code === "UNKNOWN")
  );
}

function copyPathFallback(sourcePath: string, targetPath: string) {
  removePathIfExists(targetPath);
  const stat = fs.statSync(sourcePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (stat.isDirectory()) {
    fs.cpSync(sourcePath, targetPath, { recursive: true, dereference: true });
    return;
  }
  fs.copyFileSync(sourcePath, targetPath);
}

function ensureSymlink(
  targetValue: string,
  targetPath: string,
  type: SymlinkType,
  fallbackSourcePath?: string,
) {
  try {
    fs.symlinkSync(targetValue, targetPath, type);
    return;
  } catch (error) {
    if (fallbackSourcePath && shouldFallbackToCopy(error)) {
      copyPathFallback(fallbackSourcePath, targetPath);
      return;
    }
    if (!isRecord(error) || error.code !== "EEXIST") {
      throw error;
    }
  }

  try {
    if (fs.lstatSync(targetPath).isSymbolicLink() && fs.readlinkSync(targetPath) === targetValue) {
      return;
    }
  } catch {
    // Fall through and recreate the target when inspection fails.
  }

  removePathIfExists(targetPath);
  try {
    fs.symlinkSync(targetValue, targetPath, type);
  } catch (error) {
    if (fallbackSourcePath && shouldFallbackToCopy(error)) {
      copyPathFallback(fallbackSourcePath, targetPath);
      return;
    }
    throw error;
  }
}

function symlinkPath(
  sourcePath: string,
  targetPath: string,
  finalPath = targetPath,
  type?: SymlinkType,
) {
  ensureSymlink(relativeSymlinkTarget(sourcePath, finalPath), targetPath, type, sourcePath);
}

function writeJsonFile(targetPath: string, value: unknown) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const PRIVATE_LOCAL_ONLY_PLUGIN_SDK_DIST_FILE_NAME_FALLBACK = [
  "codex-mcp-projection.js",
  "codex-session-transcript-runtime.js",
  "qa-channel.js",
  "qa-channel-protocol.js",
  "qa-lab.js",
  "qa-runtime.js",
  "ssrf-runtime-internal.js",
];

function tryReadJsonFile(targetPath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(targetPath, "utf8"));
  } catch {
    return undefined;
  }
}

function isSafePluginSdkSubpathSegment(subpath: string) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(subpath);
}

function readPrivateLocalOnlyPluginSdkDistFileNames(repoRoot: string) {
  const privateFileNames = new Set(PRIVATE_LOCAL_ONLY_PLUGIN_SDK_DIST_FILE_NAME_FALLBACK);
  const subpaths = tryReadJsonFile(
    path.join(repoRoot, "scripts", "lib", "plugin-sdk-private-local-only-subpaths.json"),
  );
  if (!Array.isArray(subpaths)) {
    return privateFileNames;
  }
  for (const subpath of subpaths) {
    if (typeof subpath === "string" && isSafePluginSdkSubpathSegment(subpath)) {
      privateFileNames.add(`${subpath}.js`);
    }
  }
  return privateFileNames;
}

function collectLegacyPublicPluginSdkDistFileNames(params: PluginSdkFileParams) {
  const privateFileNames = readPrivateLocalOnlyPluginSdkDistFileNames(params.repoRoot);
  const fileNames = new Set<string>();
  for (const dirent of fs.readdirSync(params.pluginSdkDir, { withFileTypes: true })) {
    if (!dirent.isFile() || path.extname(dirent.name) !== ".js") {
      continue;
    }
    if (privateFileNames.has(dirent.name)) {
      continue;
    }
    fileNames.add(dirent.name);
  }
  return fileNames.size > 0 ? fileNames : undefined;
}

function readPublicPluginSdkDistFileNames(params: PluginSdkFileParams) {
  const packageJson = tryReadJsonFile(path.join(params.repoRoot, "package.json"));
  if (!isRecord(packageJson)) {
    return collectLegacyPublicPluginSdkDistFileNames(params);
  }
  const packageExports = packageJson.exports;
  if (!isRecord(packageExports)) {
    return collectLegacyPublicPluginSdkDistFileNames(params);
  }

  const fileNames = new Set<string>();
  for (const exportKey of Object.keys(packageExports)) {
    if (!exportKey.startsWith("./plugin-sdk/")) {
      continue;
    }
    const subpath = exportKey.slice("./plugin-sdk/".length);
    if (isSafePluginSdkSubpathSegment(subpath)) {
      fileNames.add(`${subpath}.js`);
    }
  }

  return fileNames.size > 0 ? fileNames : collectLegacyPublicPluginSdkDistFileNames(params);
}

function buildRuntimePluginSdkPackageExports(
  publicDistFileNames: Set<string> | undefined,
): Record<string, string> {
  if (!publicDistFileNames) {
    return {};
  }

  const sortedFileNames = [...publicDistFileNames].toSorted((left, right) =>
    left.localeCompare(right),
  );
  return Object.fromEntries(
    sortedFileNames.map((fileName) => {
      const subpath = fileName.slice(0, -".js".length);
      return [`./plugin-sdk/${subpath}`, `./plugin-sdk/${fileName}`];
    }),
  );
}

function ensureOpenClawExtensionAlias(params: {
  distExtensionsRoot: string;
  repoRoot: string;
  aliasDir?: string;
}) {
  const pluginSdkDir = path.join(params.repoRoot, "dist", "plugin-sdk");
  if (!fs.existsSync(pluginSdkDir)) {
    return;
  }

  const publicDistFileNames = readPublicPluginSdkDistFileNames({
    repoRoot: params.repoRoot,
    pluginSdkDir,
  });
  const finalAliasDir = path.join(params.distExtensionsRoot, "node_modules", "openclaw");
  const aliasDir = params.aliasDir ?? finalAliasDir;
  const pluginSdkAliasPath = path.join(aliasDir, "plugin-sdk");
  fs.mkdirSync(aliasDir, { recursive: true });
  writeJsonFile(path.join(aliasDir, "package.json"), {
    name: "openclaw",
    type: "module",
    exports: buildRuntimePluginSdkPackageExports(publicDistFileNames),
  });
  removePathIfExists(pluginSdkAliasPath);
  fs.mkdirSync(pluginSdkAliasPath, { recursive: true });
  for (const dirent of fs.readdirSync(pluginSdkDir, { withFileTypes: true })) {
    if (!dirent.isFile() || path.extname(dirent.name) !== ".js") {
      continue;
    }
    if (publicDistFileNames && !publicDistFileNames.has(dirent.name)) {
      continue;
    }
    writeRuntimeModuleWrapper(
      path.join(pluginSdkDir, dirent.name),
      path.join(pluginSdkAliasPath, dirent.name),
      path.join(finalAliasDir, "plugin-sdk", dirent.name),
    );
  }
}

function shouldWrapRuntimeJsFile(sourcePath: string) {
  return path.extname(sourcePath) === ".js";
}

function isBundledSkillRuntimePath(relativePath: string) {
  return relativePath === "skills" || relativePath.startsWith("skills/");
}

function isRawBrowserExtensionAssetPath(relativePath: string) {
  return relativePath === "chrome-extension" || relativePath.endsWith("/chrome-extension");
}

function isPathOrNestedPath(relativePath: string, nestedPath: string) {
  return relativePath === nestedPath || relativePath.endsWith(`/${nestedPath}`);
}

function shouldCopyRuntimeFile(relativePath: string) {
  return (
    isBundledSkillRuntimePath(relativePath) ||
    isPathOrNestedPath(relativePath, "package.json") ||
    isPathOrNestedPath(relativePath, "openclaw.plugin.json") ||
    isPathOrNestedPath(relativePath, ".codex-plugin/plugin.json") ||
    isPathOrNestedPath(relativePath, ".claude-plugin/plugin.json") ||
    isPathOrNestedPath(relativePath, ".cursor-plugin/plugin.json") ||
    isPathOrNestedPath(relativePath, "SKILL.md")
  );
}

function hasDefaultExport(sourcePath: string) {
  const text = fs.readFileSync(sourcePath, "utf8");
  return /\bexport\s+default\b/u.test(text) || /\bas\s+default\b/u.test(text);
}

function writeRuntimeModuleWrapper(sourcePath: string, targetPath: string, finalPath = targetPath) {
  const specifier = relativeSymlinkTarget(sourcePath, finalPath).replace(/\\/g, "/");
  const normalizedSpecifier = specifier.startsWith(".") ? specifier : `./${specifier}`;
  const defaultForwarder = hasDefaultExport(sourcePath)
    ? [
        `import defaultModule from ${JSON.stringify(normalizedSpecifier)};`,
        `let defaultExport = defaultModule;`,
        `for (let index = 0; index < 4 && defaultExport && typeof defaultExport === "object" && "default" in defaultExport; index += 1) {`,
        `  defaultExport = defaultExport.default;`,
        `}`,
      ]
    : [
        `import * as module from ${JSON.stringify(normalizedSpecifier)};`,
        `let defaultExport = "default" in module ? module.default : module;`,
        `for (let index = 0; index < 4 && defaultExport && typeof defaultExport === "object" && "default" in defaultExport; index += 1) {`,
        `  defaultExport = defaultExport.default;`,
        `}`,
      ];
  fs.writeFileSync(
    targetPath,
    [
      `export * from ${JSON.stringify(normalizedSpecifier)};`,
      ...defaultForwarder,
      "export { defaultExport as default };",
      "",
    ].join("\n"),
    "utf8",
  );
}

function stagePluginRuntimeOverlay(
  sourceDir: string,
  targetDir: string,
  finalDir = targetDir,
  relativeDir = "",
): void {
  fs.mkdirSync(targetDir, { recursive: true });

  for (const dirent of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (dirent.name === "node_modules") {
      continue;
    }

    const sourcePath = path.join(sourceDir, dirent.name);
    const targetPath = path.join(targetDir, dirent.name);
    const finalPath = path.join(finalDir, dirent.name);
    const relativePath = path.join(relativeDir, dirent.name).replace(/\\/g, "/");

    if (dirent.isDirectory()) {
      // Unpacked browser extensions are executable static payloads, not Node
      // modules. Preserve the staged tree byte-for-byte so Chrome can load it.
      if (isRawBrowserExtensionAssetPath(relativePath)) {
        copyPathFallback(sourcePath, targetPath);
        continue;
      }
      stagePluginRuntimeOverlay(sourcePath, targetPath, finalPath, relativePath);
      continue;
    }

    if (dirent.isSymbolicLink()) {
      if (isBundledSkillRuntimePath(relativePath)) {
        copyPathFallback(sourcePath, targetPath);
        continue;
      }
      ensureSymlink(fs.readlinkSync(sourcePath), targetPath, undefined, sourcePath);
      continue;
    }

    if (!dirent.isFile()) {
      continue;
    }

    if (shouldWrapRuntimeJsFile(sourcePath)) {
      writeRuntimeModuleWrapper(sourcePath, targetPath, finalPath);
      continue;
    }

    if (shouldCopyRuntimeFile(relativePath)) {
      fs.copyFileSync(sourcePath, targetPath);
      continue;
    }

    symlinkPath(sourcePath, targetPath, finalPath);
  }
}

function generateBundledPluginRuntime(repoRoot: string, runtimeRoot: string, aliasDir?: string) {
  const distExtensionsRoot = path.join(repoRoot, "dist", "extensions");
  const runtimeExtensionsRoot = path.join(runtimeRoot, "extensions");
  if (!fs.existsSync(distExtensionsRoot)) {
    return;
  }
  fs.mkdirSync(runtimeExtensionsRoot, { recursive: true });
  ensureOpenClawExtensionAlias({ repoRoot, distExtensionsRoot, aliasDir });

  for (const dirent of fs.readdirSync(distExtensionsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory() || dirent.name === "node_modules") {
      continue;
    }
    const distPluginDir = path.join(distExtensionsRoot, dirent.name);
    const runtimePluginDir = path.join(runtimeExtensionsRoot, dirent.name);

    stagePluginRuntimeOverlay(
      distPluginDir,
      runtimePluginDir,
      path.join(repoRoot, "dist-runtime", "extensions", dirent.name),
    );
  }
}

/** Stages runtime plugin entries and aliases used by packaged bundled plugins. */
export function stageBundledPluginRuntime(params: { cwd?: string; repoRoot?: string } = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const runtimeRoot = path.join(repoRoot, "dist-runtime");
  assertRealOutputRoot(path.join(repoRoot, "dist"));
  assertRealOutputRoot(runtimeRoot);
  removePathIfExists(runtimeRoot);
  generateBundledPluginRuntime(repoRoot, runtimeRoot);
}

function runtimeTreesEqual(expected: string, actual: string, finalPath = actual): boolean {
  const expectedStat = fs.lstatSync(expected, { throwIfNoEntry: false });
  const actualStat = fs.lstatSync(actual, { throwIfNoEntry: false });
  if (!expectedStat || !actualStat) {
    return expectedStat === actualStat;
  }
  if (expectedStat.isSymbolicLink()) {
    const target = fs.readlinkSync(expected);
    if (actualStat.isSymbolicLink()) {
      return (
        (expectedStat.mode & 0o7777) === (actualStat.mode & 0o7777) &&
        target === fs.readlinkSync(actual)
      );
    }
    // Windows may have materialized this exact canonical link as a copy.
    return (
      process.platform === "win32" &&
      runtimeTreesEqual(fs.realpathSync(path.resolve(path.dirname(finalPath), target)), actual)
    );
  }
  if ((expectedStat.mode & 0o7777) !== (actualStat.mode & 0o7777)) {
    return false;
  }
  if (expectedStat.isFile()) {
    return (
      actualStat.isFile() &&
      expectedStat.size === actualStat.size &&
      fs.readFileSync(expected).equals(fs.readFileSync(actual))
    );
  }
  if (!expectedStat.isDirectory() || !actualStat.isDirectory()) {
    return false;
  }
  const expectedNames = fs.readdirSync(expected).toSorted();
  const actualNames = fs.readdirSync(actual).toSorted();
  return (
    expectedNames.length === actualNames.length &&
    expectedNames.every(
      (name, index) =>
        name === actualNames[index] &&
        runtimeTreesEqual(
          path.join(expected, name),
          path.join(actual, name),
          path.join(finalPath, name),
        ),
    )
  );
}

type PreparedRuntimeRoot = {
  destination: string;
  temporary: string;
  candidate: string;
  previous: string;
  changed: boolean;
  savedOriginal: boolean;
  published: boolean;
};

/** Prepare canonical outputs without touching live artifacts. The caller holds
 * checkout artifact ownership through preparation, publication, and cleanup. */
export const prepareBundledPluginRuntime: PrepareBundledPluginRuntime = (params) => {
  const repoRoot = fs.realpathSync(params.repoRoot);
  const distRoot = path.join(repoRoot, "dist");
  const runtimeRoot = path.join(repoRoot, "dist-runtime");
  const aliasRoot = path.join(distRoot, "extensions", "node_modules", "openclaw");
  for (const root of [distRoot, runtimeRoot, aliasRoot]) {
    assertRealOutputRoot(root);
  }
  const roots: PreparedRuntimeRoot[] = [];
  let phase: "prepared" | "publishing" | "published" | "failed" | "cleaned" = "prepared";
  const stageRoot = (destination: string, parent: string) => {
    const temporary = fs.mkdtempSync(path.join(fs.realpathSync(parent), ".openclaw-runtime-"));
    const entry: PreparedRuntimeRoot = {
      destination,
      temporary,
      candidate: path.join(temporary, "candidate"),
      previous: path.join(temporary, "previous"),
      changed: false,
      savedOriginal: false,
      published: false,
    };
    roots.push(entry);
    return entry;
  };
  const cleanupStaging = () => {
    const failures: unknown[] = [];
    for (const entry of roots) {
      if (phase === "failed" && (entry.savedOriginal || entry.published)) {
        continue;
      }
      try {
        fs.rmSync(entry.temporary, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Runtime staging cleanup failed.");
    }
  };
  try {
    const runtime = stageRoot(runtimeRoot, repoRoot);
    const hasAliasInput =
      fs.existsSync(path.join(distRoot, "extensions")) &&
      fs.existsSync(path.join(distRoot, "plugin-sdk"));
    const alias = hasAliasInput
      ? stageRoot(
          aliasRoot,
          fs.existsSync(path.dirname(aliasRoot)) ? path.dirname(aliasRoot) : distRoot,
        )
      : undefined;
    generateBundledPluginRuntime(repoRoot, runtime.candidate, alias?.candidate);
    if (shouldCopyStaticExtensionAssets()) {
      copyStaticExtensionAssetsToRuntimeOverlay({
        rootDir: repoRoot,
        runtimeRoot: runtime.candidate,
      });
    }
    for (const entry of roots) {
      entry.changed = !runtimeTreesEqual(entry.candidate, entry.destination);
    }
  } catch (error) {
    try {
      cleanupStaging();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Runtime preparation and cleanup failed.", {
        cause: cleanupError,
      });
    }
    throw error;
  }
  return {
    changed: roots.some((entry) => entry.changed),
    async publish(assertCurrent) {
      if (phase !== "prepared") {
        throw new Error("Prepared runtime publication is no longer available.");
      }
      phase = "publishing";
      try {
        for (const entry of roots.filter((root) => root.changed)) {
          await assertCurrent();
          assertRealOutputRoot(entry.destination);
          // A root swap stays synchronous so cancellation cannot strand its
          // original between saving it and publishing the replacement.
          if (fs.existsSync(entry.destination)) {
            fs.renameSync(entry.destination, entry.previous);
            entry.savedOriginal = true;
          }
          if (fs.existsSync(entry.candidate)) {
            fs.mkdirSync(path.dirname(entry.destination), { recursive: true });
            fs.renameSync(entry.candidate, entry.destination);
            entry.published = true;
          }
        }
        phase = "published";
      } catch (error) {
        phase = "failed";
        const failures: unknown[] = [error];
        for (const entry of roots.toReversed()) {
          if (!entry.savedOriginal && !entry.published) {
            continue;
          }
          try {
            await assertCurrent();
            if (entry.published) {
              fs.rmSync(entry.destination, { recursive: true, force: true });
              entry.published = false;
            }
            if (entry.savedOriginal) {
              fs.renameSync(entry.previous, entry.destination);
              entry.savedOriginal = false;
            }
          } catch (restoreError) {
            failures.push(
              new Error(`Runtime original retained at ${entry.previous}`, { cause: restoreError }),
            );
          }
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, "Runtime publication and restoration failed.", {
            cause: error,
          });
        }
        throw error;
      }
    },
    async cleanup() {
      if (phase === "publishing") {
        throw new Error("Cannot clean runtime staging during publication.");
      }
      cleanupStaging();
      if (phase !== "failed") {
        phase = "cleaned";
      }
    },
  };
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await withDistArtifactOwnership(process.cwd(), async () => stageBundledPluginRuntime());
}
