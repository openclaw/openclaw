import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { walkMemoryWikiDirectory } from "./bounded-walk.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { createWikiPageFilename, slugifyWikiSegment, toWikiPageSummary } from "./markdown.js";
import {
  emptySourceImportResult,
  syncImportedSourcePages,
  type BridgeMemoryWikiResult,
} from "./source-import.js";
import { renderImportedSourcePage, writeImportedSourcePage } from "./source-page-shared.js";
import { resolveArtifactKey } from "./source-path-shared.js";
import { assertMemoryWikiSourceSyncStateCapacity } from "./source-sync-state.js";

type UnsafeLocalArtifact = {
  syncKey: string;
  configuredPath: string;
  absolutePath: string;
  relativePath: string;
};

type UnsafeLocalArtifactCollection = {
  artifacts: UnsafeLocalArtifact[];
  unavailableConfiguredPaths: string[];
};

const DIRECTORY_TEXT_EXTENSIONS = new Set([".json", ".jsonl", ".md", ".txt", ".yaml", ".yml"]);
const GENERATED_IMPORTED_SOURCE_PREFIXES = ["bridge-", "unsafe-local-"];
const UNSAFE_LOCAL_SYNC_CONCURRENCY = 16;

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

async function listAllowedFilesRecursive(rootDir: string): Promise<string[]> {
  const entries = await walkMemoryWikiDirectory(rootDir, "", {
    entryFilter: (entry) =>
      entry.kind === "directory" ||
      (entry.kind === "file" &&
        DIRECTORY_TEXT_EXTENSIONS.has(
          normalizeLowercaseStringOrEmpty(path.extname(entry.relativePath)),
        ))
        ? "include"
        : "skip",
  });
  return entries
    .filter((entry) => entry.kind === "file")
    .map((entry) => path.join(rootDir, entry.relativePath))
    .toSorted((left, right) => left.localeCompare(right));
}

async function collectUnsafeLocalArtifacts(
  configuredPaths: string[],
  vaultRootKey: string,
): Promise<UnsafeLocalArtifactCollection> {
  const artifacts: UnsafeLocalArtifact[] = [];
  const unavailableConfiguredPaths: string[] = [];
  for (const configuredPath of configuredPaths) {
    const absoluteConfiguredPath = path.resolve(configuredPath);
    const scopedArtifacts: UnsafeLocalArtifact[] = [];
    try {
      const stat = await fs.stat(absoluteConfiguredPath);
      const files = stat.isDirectory()
        ? await listAllowedFilesRecursive(absoluteConfiguredPath)
        : stat.isFile()
          ? [absoluteConfiguredPath]
          : [];
      for (const absolutePath of files) {
        scopedArtifacts.push({
          syncKey: await resolveArtifactKey(absolutePath),
          configuredPath: absoluteConfiguredPath,
          absolutePath,
          relativePath: stat.isDirectory()
            ? path.relative(absoluteConfiguredPath, absolutePath).replace(/\\/g, "/")
            : path.basename(absolutePath),
        });
      }
    } catch {
      unavailableConfiguredPaths.push(absoluteConfiguredPath);
      continue;
    }
    artifacts.push(...scopedArtifacts);
  }

  const deduped = new Map<string, UnsafeLocalArtifact>();
  for (const artifact of artifacts) {
    if (isPathInside(vaultRootKey, artifact.syncKey)) {
      continue;
    }
    const sourceName = normalizeLowercaseStringOrEmpty(path.basename(artifact.absolutePath));
    if (GENERATED_IMPORTED_SOURCE_PREFIXES.some((prefix) => sourceName.startsWith(prefix))) {
      const sourcePage = toWikiPageSummary({
        absolutePath: artifact.absolutePath,
        relativePath: `sources/${sourceName}`,
        raw: await fs.readFile(artifact.absolutePath, "utf8"),
      });
      if (sourcePage?.importedSourceBody) {
        continue;
      }
    }
    deduped.set(artifact.syncKey, artifact);
  }
  return { artifacts: [...deduped.values()], unavailableConfiguredPaths };
}

function resolveUnsafeLocalPagePath(params: { configuredPath: string; absolutePath: string }): {
  pageId: string;
  pagePath: string;
} {
  const pageSlug = [params.configuredPath, params.absolutePath]
    .map((sourcePath) => {
      const slug = slugifyWikiSegment(path.basename(sourcePath));
      const hash = createHash("sha1").update(path.resolve(sourcePath)).digest("hex").slice(0, 8);
      return `${slug}-${hash}`;
    })
    .join("-");
  return {
    pageId: `source.unsafe-local.${pageSlug}`,
    pagePath: path
      .join("sources", createWikiPageFilename(`unsafe-local-${pageSlug}`))
      .replace(/\\/g, "/"),
  };
}

export async function syncMemoryWikiUnsafeLocalSources(
  config: ResolvedMemoryWikiConfig,
  options: { signal?: AbortSignal } = {},
): Promise<BridgeMemoryWikiResult> {
  if (
    config.vaultMode !== "unsafe-local" ||
    !config.unsafeLocal.allowPrivateMemoryCoreAccess ||
    config.unsafeLocal.paths.length === 0
  ) {
    return emptySourceImportResult();
  }

  const vaultRootKey = await resolveArtifactKey(config.vault.path);
  const { artifacts, unavailableConfiguredPaths } = await collectUnsafeLocalArtifacts(
    config.unsafeLocal.paths,
    vaultRootKey,
  );
  return await syncImportedSourcePages({
    config,
    group: "unsafe-local",
    signal: options.signal,
    writeSources: async ({ state, prepareWrite }) => {
      const activeKeys = new Set<string>();
      for (const [syncKey, entry] of Object.entries(state.entries)) {
        if (
          entry.group === "unsafe-local" &&
          unavailableConfiguredPaths.some((configuredPath) =>
            isPathInside(configuredPath, entry.sourcePath),
          )
        ) {
          // An unreadable configured scope remains authoritative; pruning would lose human notes.
          activeKeys.add(syncKey);
        }
      }
      assertMemoryWikiSourceSyncStateCapacity({
        state,
        group: "unsafe-local",
        incomingCount: new Set([...artifacts.map((artifact) => artifact.syncKey), ...activeKeys])
          .size,
      });
      const { results } = await runTasksWithConcurrency({
        tasks: artifacts.map((artifact) => async () => {
          const stats = await fs.stat(artifact.absolutePath);
          activeKeys.add(artifact.syncKey);
          const { pageId, pagePath } = resolveUnsafeLocalPagePath({
            configuredPath: artifact.configuredPath,
            absolutePath: artifact.absolutePath,
          });
          const title = `Unsafe Local Import: ${artifact.relativePath}`;
          const renderFingerprint = createHash("sha1")
            .update(
              JSON.stringify({
                configuredPath: artifact.configuredPath,
                relativePath: artifact.relativePath,
              }),
            )
            .digest("hex");
          return writeImportedSourcePage({
            vaultRoot: config.vault.path,
            syncKey: artifact.syncKey,
            sourcePath: artifact.absolutePath,
            sourceUpdatedAtMs: stats.mtimeMs,
            sourceSize: stats.size,
            renderFingerprint,
            pagePath,
            group: "unsafe-local",
            state,
            prepareWrite,
            buildRendered: (raw, updatedAt) =>
              renderImportedSourcePage({
                frontmatter: {
                  pageType: "source",
                  id: pageId,
                  title,
                  sourceType: "memory-unsafe-local",
                  provenanceMode: "unsafe-local",
                  sourcePath: artifact.absolutePath,
                  unsafeLocalConfiguredPath: artifact.configuredPath,
                  unsafeLocalRelativePath: artifact.relativePath,
                  status: "active",
                  updatedAt,
                },
                sourceHeading: "Unsafe Local Source",
                sourceDetails: [
                  `- Configured path: \`${artifact.configuredPath}\``,
                  `- Relative path: \`${artifact.relativePath}\``,
                  `- Updated: ${updatedAt}`,
                ],
                content: raw,
                language: detectFenceLanguage(artifact.absolutePath),
              }),
          });
        }),
        limit: UNSAFE_LOCAL_SYNC_CONCURRENCY,
        errorMode: "stop",
        throwOnError: true,
      });
      return { results, activeKeys, artifactCount: artifacts.length, workspaces: 0 };
    },
    logDetails: { configuredPathCount: config.unsafeLocal.paths.length },
  });
}
