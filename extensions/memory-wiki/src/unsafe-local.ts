// Memory Wiki plugin module implements unsafe local behavior.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BridgeMemoryWikiResult } from "./bridge.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { appendMemoryWikiLog } from "./log.js";
import {
  createWikiPageFilename,
  renderMarkdownFence,
  renderWikiMarkdown,
  slugifyWikiSegment,
} from "./markdown.js";
import { writeImportedSourcePage } from "./source-page-shared.js";
import { resolveArtifactKey } from "./source-path-shared.js";
import {
  assertMemoryWikiSourceSyncStateCapacity,
  pruneImportedSourceEntries,
  readMemoryWikiSourceSyncState,
  writeMemoryWikiSourceSyncState,
} from "./source-sync-state.js";
import { initializeMemoryWikiVault } from "./vault.js";

type UnsafeLocalArtifact = {
  syncKey: string;
  configuredPath: string;
  absolutePath: string;
  relativePath: string;
};

const DIRECTORY_TEXT_EXTENSIONS = new Set([".json", ".jsonl", ".md", ".txt", ".yaml", ".yml"]);

function detectFenceLanguage(filePath: string): string {
  const ext = normalizeLowercaseStringOrEmpty(path.extname(filePath));
  if (ext === ".json" || ext === ".jsonl") {
    return "json";
  }
  if (ext === ".yaml" || ext === ".yml") {
    return "yaml";
  }
  if (ext === ".txt") {
    return "text";
  }
  return "markdown";
}

// `readable` is false when this directory or any descendant could not be read
// (an unmounted/undocked volume), which is distinct from a readable-but-empty
// directory. It propagates up so a transiently-gone nested mount is not mistaken
// for deletion; callers use it to skip pruning during an outage (#97523).
async function listAllowedFilesRecursive(
  rootDir: string,
): Promise<{ files: string[]; readable: boolean }> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => null);
  if (entries === null) {
    return { files: [], readable: false };
  }
  const files: string[] = [];
  let readable = true;
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listAllowedFilesRecursive(fullPath);
      files.push(...nested.files);
      if (!nested.readable) {
        readable = false;
      }
      continue;
    }
    if (
      entry.isFile() &&
      DIRECTORY_TEXT_EXTENSIONS.has(normalizeLowercaseStringOrEmpty(path.extname(entry.name)))
    ) {
      files.push(fullPath);
    }
  }
  return { files: files.toSorted((left, right) => left.localeCompare(right)), readable };
}

async function collectUnsafeLocalArtifacts(
  configuredPaths: string[],
): Promise<{ artifacts: UnsafeLocalArtifact[]; unreadableRoots: string[] }> {
  const artifacts: UnsafeLocalArtifact[] = [];
  // Configured roots that could not be fully read (undocked drive, unmounted
  // NAS, not-yet-mounted nested mount, or a missing explicit file) are
  // transiently absent, not deleted. The caller preserves imported entries under
  // these roots from pruning while still cleaning up readable roots (#97523).
  const unreadableRoots: string[] = [];
  for (const configuredPath of configuredPaths) {
    const absoluteConfiguredPath = path.resolve(configuredPath);
    const stat = await fs.stat(absoluteConfiguredPath).catch(() => null);
    if (!stat) {
      unreadableRoots.push(absoluteConfiguredPath);
      continue;
    }
    if (stat.isDirectory()) {
      const listing = await listAllowedFilesRecursive(absoluteConfiguredPath);
      // A nested mount that is gone still imports the files we can read, but the
      // root is marked unreadable so its entries are not pruned during the outage.
      if (!listing.readable) {
        unreadableRoots.push(absoluteConfiguredPath);
      }
      for (const absolutePath of listing.files) {
        artifacts.push({
          syncKey: await resolveArtifactKey(absolutePath),
          configuredPath: absoluteConfiguredPath,
          absolutePath,
          relativePath: path.relative(absoluteConfiguredPath, absolutePath).replace(/\\/g, "/"),
        });
      }
      continue;
    }
    if (stat.isFile()) {
      artifacts.push({
        syncKey: await resolveArtifactKey(absoluteConfiguredPath),
        configuredPath: absoluteConfiguredPath,
        absolutePath: absoluteConfiguredPath,
        relativePath: path.basename(absoluteConfiguredPath),
      });
    }
  }

  const deduped = new Map<string, UnsafeLocalArtifact>();
  for (const artifact of artifacts) {
    deduped.set(artifact.syncKey, artifact);
  }
  return { artifacts: [...deduped.values()], unreadableRoots };
}

function isPathAtOrWithin(target: string, root: string): boolean {
  if (target === root) {
    return true;
  }
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target.startsWith(rootWithSep);
}

// Keep imported entries whose source lives under a transiently unreadable root
// out of the prune by marking their keys active, so a temporary outage cannot
// delete their pages or human-notes while readable roots still clean up (#97523).
function preserveEntriesUnderUnreadableRoots(params: {
  state: Awaited<ReturnType<typeof readMemoryWikiSourceSyncState>>;
  unreadableRoots: string[];
  activeKeys: Set<string>;
}): void {
  if (params.unreadableRoots.length === 0) {
    return;
  }
  for (const [syncKey, entry] of Object.entries(params.state.entries)) {
    if (entry.group !== "unsafe-local") {
      continue;
    }
    if (params.unreadableRoots.some((root) => isPathAtOrWithin(entry.sourcePath, root))) {
      params.activeKeys.add(syncKey);
    }
  }
}

function resolveUnsafeLocalPagePath(params: { configuredPath: string; absolutePath: string }): {
  pageId: string;
  pagePath: string;
} {
  const configuredBaseSlug = slugifyWikiSegment(path.basename(params.configuredPath));
  const configuredHash = createHash("sha1")
    .update(path.resolve(params.configuredPath))
    .digest("hex")
    .slice(0, 8);
  const artifactBaseSlug = slugifyWikiSegment(path.basename(params.absolutePath));
  const artifactHash = createHash("sha1")
    .update(path.resolve(params.absolutePath))
    .digest("hex")
    .slice(0, 8);
  const pageSlug = `${configuredBaseSlug}-${configuredHash}-${artifactBaseSlug}-${artifactHash}`;
  return {
    pageId: `source.unsafe-local.${pageSlug}`,
    pagePath: path
      .join("sources", createWikiPageFilename(`unsafe-local-${pageSlug}`))
      .replace(/\\/g, "/"),
  };
}

function resolveUnsafeLocalTitle(artifact: UnsafeLocalArtifact): string {
  return `Unsafe Local Import: ${artifact.relativePath}`;
}

async function writeUnsafeLocalSourcePage(params: {
  config: ResolvedMemoryWikiConfig;
  artifact: UnsafeLocalArtifact;
  sourceUpdatedAtMs: number;
  sourceSize: number;
  state: Awaited<ReturnType<typeof readMemoryWikiSourceSyncState>>;
}): Promise<{ pagePath: string; changed: boolean; created: boolean }> {
  const { pageId, pagePath } = resolveUnsafeLocalPagePath({
    configuredPath: params.artifact.configuredPath,
    absolutePath: params.artifact.absolutePath,
  });
  const title = resolveUnsafeLocalTitle(params.artifact);
  const renderFingerprint = createHash("sha1")
    .update(
      JSON.stringify({
        configuredPath: params.artifact.configuredPath,
        relativePath: params.artifact.relativePath,
      }),
    )
    .digest("hex");
  return writeImportedSourcePage({
    vaultRoot: params.config.vault.path,
    syncKey: params.artifact.syncKey,
    sourcePath: params.artifact.absolutePath,
    sourceUpdatedAtMs: params.sourceUpdatedAtMs,
    sourceSize: params.sourceSize,
    renderFingerprint,
    pagePath,
    group: "unsafe-local",
    state: params.state,
    buildRendered: (raw, updatedAt) =>
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: pageId,
          title,
          sourceType: "memory-unsafe-local",
          provenanceMode: "unsafe-local",
          sourcePath: params.artifact.absolutePath,
          unsafeLocalConfiguredPath: params.artifact.configuredPath,
          unsafeLocalRelativePath: params.artifact.relativePath,
          status: "active",
          updatedAt,
        },
        body: [
          `# ${title}`,
          "",
          "## Unsafe Local Source",
          `- Configured path: \`${params.artifact.configuredPath}\``,
          `- Relative path: \`${params.artifact.relativePath}\``,
          `- Updated: ${updatedAt}`,
          "",
          "## Content",
          renderMarkdownFence(raw, detectFenceLanguage(params.artifact.absolutePath)),
          "",
          "## Notes",
          "<!-- openclaw:human:start -->",
          "<!-- openclaw:human:end -->",
          "",
        ].join("\n"),
      }),
  });
}

export async function syncMemoryWikiUnsafeLocalSources(
  config: ResolvedMemoryWikiConfig,
): Promise<BridgeMemoryWikiResult> {
  await initializeMemoryWikiVault(config);
  if (
    config.vaultMode !== "unsafe-local" ||
    !config.unsafeLocal.allowPrivateMemoryCoreAccess ||
    config.unsafeLocal.paths.length === 0
  ) {
    return {
      importedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      removedCount: 0,
      artifactCount: 0,
      workspaces: 0,
      pagePaths: [],
    };
  }

  const { artifacts, unreadableRoots } = await collectUnsafeLocalArtifacts(
    config.unsafeLocal.paths,
  );
  const state = await readMemoryWikiSourceSyncState(config.vault.path);
  assertMemoryWikiSourceSyncStateCapacity({
    state,
    group: "unsafe-local",
    incomingCount: artifacts.length,
  });
  const activeKeys = new Set<string>();
  const results = await Promise.all(
    artifacts.map(async (artifact) => {
      const stats = await fs.stat(artifact.absolutePath);
      activeKeys.add(artifact.syncKey);
      return await writeUnsafeLocalSourcePage({
        config,
        artifact,
        sourceUpdatedAtMs: stats.mtimeMs,
        sourceSize: stats.size,
        state,
      });
    }),
  );

  // A transiently unreadable root collects zero artifacts the same way a real
  // deletion does, so its entries would otherwise be pruned, hard-deleting their
  // pages and human-notes blocks with nothing left to restore. Preserve those
  // entries per-root, then prune normally so readable roots still clean up their
  // genuinely deleted files. See #97523.
  preserveEntriesUnderUnreadableRoots({ state, unreadableRoots, activeKeys });
  const removedCount = await pruneImportedSourceEntries({
    vaultRoot: config.vault.path,
    group: "unsafe-local",
    activeKeys,
    state,
  });
  await writeMemoryWikiSourceSyncState(config.vault.path, state);
  const importedCount = results.filter((result) => result.changed && result.created).length;
  const updatedCount = results.filter((result) => result.changed && !result.created).length;
  const skippedCount = results.filter((result) => !result.changed).length;
  const pagePaths = results
    .map((result) => result.pagePath)
    .toSorted((left, right) => left.localeCompare(right));

  if (importedCount > 0 || updatedCount > 0 || removedCount > 0) {
    await appendMemoryWikiLog(config.vault.path, {
      type: "ingest",
      timestamp: new Date().toISOString(),
      details: {
        sourceType: "memory-unsafe-local",
        configuredPathCount: config.unsafeLocal.paths.length,
        artifactCount: artifacts.length,
        importedCount,
        updatedCount,
        skippedCount,
        removedCount,
      },
    });
  }

  return {
    importedCount,
    updatedCount,
    skippedCount,
    removedCount,
    artifactCount: artifacts.length,
    workspaces: 0,
    pagePaths,
  };
}
