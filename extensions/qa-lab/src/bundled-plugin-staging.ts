import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeStringEntries, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { coerce as coerceSemver } from "semver";

const QA_ALWAYS_STAGE_RUNTIME_PLUGIN_IDS = Object.freeze(["image-generation-core"]);
const QA_OPENAI_PLUGIN_ID = "openai";
const QA_BUNDLED_PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const QA_CLI_METADATA_ENTRY_BASENAMES = Object.freeze([
  "cli-metadata.ts",
  "cli-metadata.js",
  "cli-metadata.mjs",
  "cli-metadata.cjs",
]);

function isQaOpenAiResponsesProviderConfig(config: ModelProviderConfig) {
  return (
    config.api === "openai-responses" ||
    config.models.some((model) => model.api === "openai-responses")
  );
}

function resolveQaBundledPluginScanRoots(repoRoot: string) {
  const candidates = [
    path.join(repoRoot, "dist", "extensions"),
    path.join(repoRoot, "dist-runtime", "extensions"),
    path.join(repoRoot, "extensions"),
  ];
  return uniqueStrings(candidates.filter((candidate) => existsSync(candidate)));
}

function readQaBundledManifestId(manifestPath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { id?: unknown };
    return typeof parsed.id === "string" ? parsed.id.trim() || null : null;
  } catch {
    return null;
  }
}

function findQaBundledPluginDirsByManifestId(params: {
  repoRoot: string;
  pluginId: string;
}): string[] {
  const candidates: string[] = [];
  for (const sourceRoot of resolveQaBundledPluginScanRoots(params.repoRoot)) {
    for (const entry of readdirSync(sourceRoot, { withFileTypes: true }).toSorted((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = path.join(sourceRoot, entry.name);
      const manifestId = readQaBundledManifestId(path.join(candidate, "openclaw.plugin.json"));
      if (manifestId === params.pluginId) {
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

export async function resolveQaOwnerPluginIdsForProviderIds(params: {
  repoRoot: string;
  providerIds: readonly string[];
  providerConfigs?: Record<string, ModelProviderConfig>;
}) {
  const providerIds = uniqueStrings(normalizeStringEntries(params.providerIds));
  if (providerIds.length === 0) {
    return [];
  }
  const remainingProviderIds = new Set(providerIds);
  const ownerPluginIds = new Set<string>();
  const visitedPluginIds = new Set<string>();
  for (const sourceRoot of resolveQaBundledPluginScanRoots(params.repoRoot)) {
    for (const entry of await fs.readdir(sourceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const manifestPath = path.join(sourceRoot, entry.name, "openclaw.plugin.json");
      if (!existsSync(manifestPath)) {
        continue;
      }
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
        id?: unknown;
        providers?: unknown;
        cliBackends?: unknown;
      };
      const pluginId = typeof manifest.id === "string" ? manifest.id.trim() : entry.name;
      if (!pluginId || visitedPluginIds.has(pluginId)) {
        continue;
      }
      visitedPluginIds.add(pluginId);
      const ownedIds = new Set(
        [
          pluginId,
          ...(Array.isArray(manifest.providers) ? manifest.providers : []),
          ...(Array.isArray(manifest.cliBackends) ? manifest.cliBackends : []),
        ].filter((ownedId): ownedId is string => typeof ownedId === "string"),
      );
      for (const providerId of providerIds) {
        if (!ownedIds.has(providerId)) {
          continue;
        }
        ownerPluginIds.add(pluginId);
        remainingProviderIds.delete(providerId);
      }
    }
  }
  for (const providerId of remainingProviderIds) {
    const providerConfig = params.providerConfigs?.[providerId];
    if (providerConfig && isQaOpenAiResponsesProviderConfig(providerConfig)) {
      ownerPluginIds.add(QA_OPENAI_PLUGIN_ID);
      continue;
    }
    ownerPluginIds.add(providerId);
  }
  return [...ownerPluginIds];
}

function collectQaBundledPluginSources(params: {
  repoRoot: string;
  allowedPluginIds: readonly string[];
}) {
  const sources = new Map<string, { sourceDir: string; manifestPath: string | undefined }>();
  const roots = resolveQaBundledPluginScanRoots(params.repoRoot);
  const sourceExtensionsRoot = path.join(params.repoRoot, "extensions");
  for (const pluginId of [...params.allowedPluginIds, ...QA_ALWAYS_STAGE_RUNTIME_PLUGIN_IDS]) {
    if (!QA_BUNDLED_PLUGIN_ID_PATTERN.test(pluginId)) {
      throw new Error(`invalid QA bundled plugin id: ${pluginId}`);
    }
    const manifestDirs = findQaBundledPluginDirsByManifestId({
      repoRoot: params.repoRoot,
      pluginId,
    });
    const candidates = uniqueStrings([
      ...roots.map((root) => path.join(root, pluginId)).filter(existsSync),
      ...manifestDirs,
    ]);
    const sourceDir =
      candidates.find((candidate) =>
        QA_CLI_METADATA_ENTRY_BASENAMES.some((basename) =>
          existsSync(path.join(candidate, basename)),
        ),
      ) ?? candidates[0];
    if (sourceDir) {
      const manifestDir =
        manifestDirs.find((candidate) => path.dirname(candidate) === sourceExtensionsRoot) ??
        manifestDirs[0];
      sources.set(pluginId, {
        sourceDir,
        manifestPath: manifestDir ? path.join(manifestDir, "openclaw.plugin.json") : undefined,
      });
    }
  }
  return sources;
}

function resolveQaBuiltBundledPluginTreeRoot(params: { repoRoot: string; sourceDir: string }) {
  const sourceDir = path.resolve(params.sourceDir);
  for (const treeName of ["dist", "dist-runtime"] as const) {
    const extensionsRoot = path.join(params.repoRoot, treeName, "extensions");
    const relativeSourceDir = path.relative(extensionsRoot, sourceDir);
    if (
      relativeSourceDir.length > 0 &&
      !relativeSourceDir.startsWith("..") &&
      !path.isAbsolute(relativeSourceDir)
    ) {
      return path.join(params.repoRoot, treeName);
    }
  }
  return null;
}

async function symlinkQaStagedDirEntry(sourcePath: string, targetPath: string, directory: boolean) {
  await fs.symlink(
    sourcePath,
    targetPath,
    directory ? (process.platform === "win32" ? "junction" : "dir") : "file",
  );
}

async function symlinkQaStagedEntry(sourceDir: string, targetDir: string, entry: Dirent) {
  const sourcePath = path.join(sourceDir, entry.name);
  await symlinkQaStagedDirEntry(
    sourcePath,
    path.join(targetDir, entry.name),
    entry.isDirectory() || (entry.isSymbolicLink() && (await fs.stat(sourcePath)).isDirectory()),
  );
}

async function seedQaStagedNodeModules(params: { repoRoot: string; stagedRoot: string }) {
  const sourceNodeModulesDir = path.join(params.repoRoot, "node_modules");
  if (!existsSync(sourceNodeModulesDir)) {
    return;
  }
  const stagedNodeModulesDir = path.join(params.stagedRoot, "node_modules");
  await fs.mkdir(stagedNodeModulesDir, { recursive: true });
  for (const entry of await fs.readdir(sourceNodeModulesDir, { withFileTypes: true })) {
    if (entry.name === "openclaw") {
      continue;
    }
    await symlinkQaStagedEntry(sourceNodeModulesDir, stagedNodeModulesDir, entry);
  }
}

async function seedQaStagedBuiltTreeRoots(params: {
  stagedTreeRoot: string;
  sourceTreeRoots: readonly string[];
}) {
  for (const sourceTreeRoot of params.sourceTreeRoots) {
    if (!existsSync(sourceTreeRoot)) {
      continue;
    }
    for (const entry of await fs.readdir(sourceTreeRoot, { withFileTypes: true })) {
      if (entry.name === "extensions") {
        continue;
      }
      const targetPath = path.join(params.stagedTreeRoot, entry.name);
      if (existsSync(targetPath)) {
        continue;
      }
      await symlinkQaStagedEntry(sourceTreeRoot, params.stagedTreeRoot, entry);
    }
  }
}

export async function resolveQaRuntimeHostVersion(params: {
  repoRoot: string;
  allowedPluginIds: readonly string[];
}) {
  const rootPackageRaw = await fs.readFile(path.join(params.repoRoot, "package.json"), "utf8");
  const rootPackage = JSON.parse(rootPackageRaw) as { version?: string };
  let selected = coerceSemver(rootPackage.version);
  for (const { sourceDir } of collectQaBundledPluginSources(params).values()) {
    const packagePath = path.join(sourceDir, "package.json");
    if (!existsSync(packagePath)) {
      continue;
    }
    const packageRaw = await fs.readFile(packagePath, "utf8");
    const packageJson = JSON.parse(packageRaw) as {
      openclaw?: {
        install?: {
          minHostVersion?: string;
        };
      };
    };
    const candidate = coerceSemver(packageJson.openclaw?.install?.minHostVersion);
    if (candidate && (!selected || candidate.compare(selected) > 0)) {
      selected = candidate;
    }
  }

  return selected?.version;
}

export function resolveQaStagedBundledPluginsRoot(params: { repoRoot: string; tempRoot: string }) {
  return path.join(params.repoRoot, ".artifacts", "qa-runtime", path.basename(params.tempRoot));
}

export async function createQaBundledPluginsDir(params: {
  repoRoot: string;
  tempRoot: string;
  allowedPluginIds: readonly string[];
}) {
  const stagedPluginSources = collectQaBundledPluginSources(params);
  const stagedRoot = resolveQaStagedBundledPluginsRoot(params);
  await fs.rm(stagedRoot, { recursive: true, force: true });
  await fs.mkdir(stagedRoot, { recursive: true });
  await fs.copyFile(
    path.join(params.repoRoot, "package.json"),
    path.join(stagedRoot, "package.json"),
  );
  await seedQaStagedNodeModules({
    repoRoot: params.repoRoot,
    stagedRoot,
  });
  const stagedOpenClawPackageDir = path.join(stagedRoot, "node_modules", "openclaw");
  await fs.mkdir(stagedOpenClawPackageDir, { recursive: true });
  await fs.copyFile(
    path.join(params.repoRoot, "package.json"),
    path.join(stagedOpenClawPackageDir, "package.json"),
  );
  const stagedTreeName =
    !existsSync(path.join(params.repoRoot, "dist")) &&
    existsSync(path.join(params.repoRoot, "dist-runtime"))
      ? "dist-runtime"
      : "dist";
  const stagedTreeRoot = path.join(stagedRoot, stagedTreeName);
  await fs.mkdir(stagedTreeRoot, { recursive: true });
  await seedQaStagedBuiltTreeRoots({
    stagedTreeRoot,
    sourceTreeRoots: uniqueStrings([
      path.join(params.repoRoot, stagedTreeName),
      ...[...stagedPluginSources.values()].flatMap(({ sourceDir }) => {
        const treeRoot = resolveQaBuiltBundledPluginTreeRoot({
          repoRoot: params.repoRoot,
          sourceDir,
        });
        return treeRoot ? [treeRoot] : [];
      }),
    ]),
  });
  if (stagedTreeName === "dist-runtime" && !existsSync(path.join(stagedRoot, "dist"))) {
    const repoDistDir = path.join(params.repoRoot, "dist");
    const stagedDistTarget = existsSync(repoDistDir) ? repoDistDir : stagedTreeRoot;
    await symlinkQaStagedDirEntry(stagedDistTarget, path.join(stagedRoot, "dist"), true);
  }
  const bundledPluginsDir = path.join(stagedTreeRoot, "extensions");
  await fs.mkdir(bundledPluginsDir, { recursive: true });
  for (const [pluginId, { sourceDir, manifestPath }] of stagedPluginSources) {
    const targetDir = path.join(bundledPluginsDir, pluginId);
    await fs.cp(sourceDir, targetDir, { recursive: true });
    // Compiled extension trees omit static manifests. Restore the canonical
    // source manifest so activation and tool metadata match the built code.
    if (manifestPath) {
      await fs.copyFile(manifestPath, path.join(targetDir, "openclaw.plugin.json"));
    }
  }
  await symlinkQaStagedDirEntry(
    path.join(stagedRoot, "dist"),
    path.join(stagedOpenClawPackageDir, "dist"),
    true,
  );
  return {
    bundledPluginsDir,
    stagedRoot,
  };
}
