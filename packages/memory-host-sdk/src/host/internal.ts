import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { runWithConcurrency as runWithConcurrencyImpl } from "./concurrency.js";
import { MEMORY_HOST_ROOT_FILENAME, normalizeConfiguredMemoryExtraPaths } from "./config-utils.js";
import { estimateStructuredEmbeddingInputBytes } from "./embedding-input-limits.js";
import type { EmbeddingInput } from "./embedding-inputs.js";
import { isExplicitExtraMarkdownFilePath } from "./explicit-extra-markdown.js";
import {
  isFileMissingError,
  isPathInside,
  readRegularFile,
  statRegularFile,
  walkDirectory,
  type WalkDirectoryEntry,
} from "./fs-utils.js";
import { hashText } from "./hash.js";
import type { MemoryChunk } from "./markdown-chunks.js";
import {
  buildMemoryMultimodalLabel,
  classifyMemoryMultimodalPath,
  type MemoryMultimodalModality,
  type MemoryMultimodalSettings,
} from "./multimodal.js";
import { detectMime } from "./openclaw-runtime-io.js";
import {
  resolveCanonicalRootMemoryFile,
  shouldSkipRootMemoryAuxiliaryPath,
} from "./openclaw-runtime-memory.js";
import { retryTransientMemoryRead } from "./read-retry.js";
import type { MemoryExtraPath } from "./types.js";

export { hashText } from "./hash.js";
export { parseEmbedding, cosineSimilarity } from "./embedding-vector.js";
export {
  chunkMarkdown,
  splitCuratedMarkdownEntries,
  remapChunkLines,
  MEMORY_CHUNKING_VERSION,
  type MemoryChunk,
  type CuratedMarkdownEntry,
} from "./markdown-chunks.js";

export type MemoryFileEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  dataHash?: string;
  kind?: "markdown" | "multimodal";
  contentText?: string;
  modality?: MemoryMultimodalModality;
  mimeType?: string;
};

type MultimodalMemoryChunk = {
  chunk: MemoryChunk;
  structuredInputBytes: number;
};

const DISABLED_MULTIMODAL_SETTINGS: MemoryMultimodalSettings = {
  enabled: false,
  modalities: [],
  maxFileBytes: 0,
};

function ensureMemoryHostDir(dir: string): string {
  fsSync.mkdirSync(dir, { recursive: true });
  return dir;
}

export { ensureMemoryHostDir as ensureDir };

// File discovery skips non-regular entries. Keep the same rule when a listed
// file changes before its index entry is built, or one path can abort the sync.
async function statEnumerableMemoryFile(absPath: string): Promise<fsSync.Stats | null> {
  try {
    const stat = await fs.lstat(absPath);
    return stat.isFile() ? stat : null;
  } catch (error) {
    if (isFileMissingError(error)) {
      return null;
    }
    throw error;
  }
}

function normalizeRelPath(value: string): string {
  const trimmed = value.trim().replace(/^[./]+/, "");
  return trimmed.replace(/\\/g, "/");
}

function expandHomePath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

export type NormalizedExtraMemoryPath = { path: string; pattern?: string };

export function normalizeExtraMemoryPathEntries(
  workspaceDir: string,
  extraPaths?: MemoryExtraPath[],
): NormalizedExtraMemoryPath[] {
  return normalizeConfiguredMemoryExtraPaths(extraPaths).map((entry) => {
    const configuredPath = typeof entry === "string" ? entry : entry.path;
    const normalized: NormalizedExtraMemoryPath = {
      path: path.resolve(workspaceDir, expandHomePath(configuredPath)),
    };
    if (typeof entry !== "string") {
      normalized.pattern = entry.pattern?.replaceAll("\\", "/");
    }
    return normalized;
  });
}

export function normalizeExtraMemoryPaths(
  workspaceDir: string,
  extraPaths?: MemoryExtraPath[],
): string[] {
  return Array.from(
    new Set(normalizeExtraMemoryPathEntries(workspaceDir, extraPaths).map((entry) => entry.path)),
  );
}

export function matchesExtraMemoryPathEntry(
  entry: NormalizedExtraMemoryPath,
  candidatePath: string,
): boolean {
  if (!entry.pattern) {
    return true;
  }
  const relativePath = path.relative(entry.path, candidatePath);
  try {
    return (
      !relativePath ||
      (isPathInside(entry.path, candidatePath) &&
        path.posix.matchesGlob(relativePath.replaceAll(path.sep, "/"), entry.pattern))
    );
  } catch {
    return false;
  }
}

export function isMemoryPath(relPath: string): boolean {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) {
    return false;
  }
  if (
    normalized === MEMORY_HOST_ROOT_FILENAME ||
    normalized === "USER.md" ||
    normalized.toLowerCase() === "dreams.md"
  ) {
    return true;
  }
  return normalized.startsWith("memory/");
}

function isAllowedMemoryFilePath(filePath: string, multimodal?: MemoryMultimodalSettings): boolean {
  if (filePath.endsWith(".md")) {
    return true;
  }
  return (
    classifyMemoryMultimodalPath(filePath, multimodal ?? DISABLED_MULTIMODAL_SETTINGS) !== null
  );
}

function shouldDescendMemoryEntry(
  entry: WalkDirectoryEntry,
  shouldSkipPath?: (absPath: string) => boolean,
): boolean {
  if (shouldSkipPath?.(entry.path)) {
    return false;
  }
  return entry.kind === "directory" && entry.name !== ".openclaw-repair";
}

class MemorySourceScanError extends Error {
  readonly path: string;
  readonly code?: string;

  constructor(sourcePath: string, cause: unknown) {
    const code =
      cause !== null &&
      typeof cause === "object" &&
      "code" in cause &&
      typeof cause.code === "string"
        ? cause.code
        : undefined;
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`memory source scan failed at ${sourcePath}${code ? ` (${code})` : ""}: ${detail}`, {
      cause,
    });
    this.name = "MemorySourceScanError";
    this.path = sourcePath;
    this.code = code;
  }
}

async function scanMemorySource<T>(sourcePath: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isFileMissingError(error) || error instanceof MemorySourceScanError) {
      throw error;
    }
    throw new MemorySourceScanError(sourcePath, error);
  }
}

async function collectMemoryFilesFromDir(
  dir: string,
  files: string[],
  multimodal?: MemoryMultimodalSettings,
  shouldSkipPath?: (absPath: string) => boolean,
  extraPathEntry?: NormalizedExtraMemoryPath,
): Promise<void> {
  const scan = await scanMemorySource(dir, () =>
    walkDirectory(dir, {
      symlinks: "skip",
      descend: (entry) => shouldDescendMemoryEntry(entry, shouldSkipPath),
      include: (entry) =>
        !shouldSkipPath?.(entry.path) &&
        entry.kind === "file" &&
        isAllowedMemoryFilePath(entry.path, multimodal) &&
        (!extraPathEntry || matchesExtraMemoryPathEntry(extraPathEntry, entry.path)),
    }),
  );
  const operationalFailure = scan.failedDirs.find((failure) => !isFileMissingError(failure.error));
  if (operationalFailure) {
    throw new MemorySourceScanError(operationalFailure.path, operationalFailure.error);
  }
  files.push(...scan.entries.map((entry) => entry.path).toSorted());
}

export async function listMemoryFiles(
  workspaceDir: string,
  extraPaths?: MemoryExtraPath[],
  multimodal?: MemoryMultimodalSettings,
  onSkippedSymlinkRoot?: (root: string) => void,
): Promise<string[]> {
  const result: string[] = [];
  const memoryDir = path.join(workspaceDir, "memory");

  const shouldSkipWorkspaceMemoryPath = (absPath: string): boolean =>
    shouldSkipRootMemoryAuxiliaryPath({ workspaceDir, absPath });

  const addMarkdownFile = async (absPath: string) => {
    const stat = await scanMemorySource(absPath, () => statEnumerableMemoryFile(absPath));
    if (!stat || !absPath.endsWith(".md")) {
      return;
    }
    result.push(absPath);
  };

  const memoryFile = await scanMemorySource(workspaceDir, () =>
    resolveCanonicalRootMemoryFile(workspaceDir),
  );
  if (memoryFile) {
    await addMarkdownFile(memoryFile);
  }
  await addMarkdownFile(path.join(workspaceDir, "USER.md"));
  try {
    const dirStat = await scanMemorySource(memoryDir, () => fs.lstat(memoryDir));
    if (!dirStat.isSymbolicLink() && dirStat.isDirectory()) {
      // Default memory roots stay Markdown-only; multimodal discovery is an extraPaths opt-in.
      await collectMemoryFilesFromDir(memoryDir, result, undefined, shouldSkipWorkspaceMemoryPath);
    }
  } catch (error) {
    if (!isFileMissingError(error)) {
      throw error;
    }
  }

  const normalizedExtraPaths = normalizeExtraMemoryPathEntries(workspaceDir, extraPaths);
  if (normalizedExtraPaths.length > 0) {
    for (const entry of normalizedExtraPaths) {
      const inputPath = entry.path;
      if (shouldSkipWorkspaceMemoryPath(inputPath)) {
        continue;
      }
      try {
        const stat = await scanMemorySource(inputPath, () => fs.lstat(inputPath));
        if (stat.isSymbolicLink()) {
          onSkippedSymlinkRoot?.(inputPath);
          continue;
        }
        if (stat.isDirectory()) {
          await collectMemoryFilesFromDir(
            inputPath,
            result,
            multimodal,
            shouldSkipWorkspaceMemoryPath,
            entry,
          );
          continue;
        }
        if (
          stat.isFile() &&
          (isExplicitExtraMarkdownFilePath(inputPath) ||
            isAllowedMemoryFilePath(inputPath, multimodal))
        ) {
          result.push(inputPath);
        }
      } catch (error) {
        if (!isFileMissingError(error)) {
          throw error;
        }
      }
    }
  }
  if (result.length <= 1) {
    return result;
  }
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const entry of result) {
    let key = entry;
    try {
      key = await fs.realpath(entry);
    } catch {}
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

export async function buildFileEntry(
  absPath: string,
  workspaceDir: string,
  multimodal?: MemoryMultimodalSettings,
): Promise<MemoryFileEntry | null> {
  const stat = await statEnumerableMemoryFile(absPath);
  if (!stat) {
    return null;
  }
  const normalizedPath = path.relative(workspaceDir, absPath).replace(/\\/g, "/");
  const multimodalSettings = multimodal ?? DISABLED_MULTIMODAL_SETTINGS;
  const modality = classifyMemoryMultimodalPath(absPath, multimodalSettings);
  if (modality) {
    if (stat.size > multimodalSettings.maxFileBytes) {
      return null;
    }
    let buffer: Buffer;
    try {
      buffer = (
        await retryTransientMemoryRead(
          () =>
            readRegularFile({
              filePath: absPath,
              maxBytes: multimodalSettings.maxFileBytes,
            }),
          `read multimodal memory file ${absPath}`,
        )
      ).buffer;
    } catch (err) {
      if (isFileMissingError(err)) {
        return null;
      }
      throw err;
    }
    const mimeType = await detectMime({ buffer: buffer.subarray(0, 512), filePath: absPath });
    if (!mimeType || !mimeType.startsWith(`${modality}/`)) {
      return null;
    }
    const contentText = buildMemoryMultimodalLabel(modality, normalizedPath);
    const dataHash = crypto.createHash("sha256").update(buffer).digest("hex");
    const chunkHash = hashText(
      JSON.stringify({
        path: normalizedPath,
        contentText,
        mimeType,
        dataHash,
      }),
    );
    return {
      path: normalizedPath,
      absPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: chunkHash,
      dataHash,
      kind: "multimodal",
      contentText,
      modality,
      mimeType,
    };
  }
  let content: string;
  try {
    content = (
      await retryTransientMemoryRead(
        () => readRegularFile({ filePath: absPath }),
        `read memory index file ${absPath}`,
      )
    ).buffer.toString("utf-8");
  } catch (err) {
    if (isFileMissingError(err)) {
      return null;
    }
    throw err;
  }
  const hash = hashText(content);
  return {
    path: normalizedPath,
    absPath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    hash,
    kind: "markdown",
  };
}

async function loadMultimodalEmbeddingInput(
  entry: Pick<
    MemoryFileEntry,
    "absPath" | "contentText" | "mimeType" | "kind" | "size" | "dataHash"
  >,
): Promise<EmbeddingInput | null> {
  if (entry.kind !== "multimodal" || !entry.contentText || !entry.mimeType) {
    return null;
  }
  const regularFile = await statRegularFile(entry.absPath);
  if (regularFile.missing) {
    return null;
  }
  const stat = regularFile.stat;
  if (stat.size !== entry.size) {
    return null;
  }
  let buffer: Buffer;
  try {
    buffer = (
      await retryTransientMemoryRead(
        () => readRegularFile({ filePath: entry.absPath, maxBytes: entry.size }),
        `read multimodal indexing file ${entry.absPath}`,
      )
    ).buffer;
  } catch (err) {
    if (isFileMissingError(err)) {
      return null;
    }
    throw err;
  }
  const dataHash = crypto.createHash("sha256").update(buffer).digest("hex");
  if (entry.dataHash && entry.dataHash !== dataHash) {
    return null;
  }
  return {
    text: entry.contentText,
    parts: [
      { type: "text", text: entry.contentText },
      {
        type: "inline-data",
        mimeType: entry.mimeType,
        data: buffer.toString("base64"),
      },
    ],
  };
}

export async function buildMultimodalChunkForIndexing(
  entry: Pick<
    MemoryFileEntry,
    "absPath" | "contentText" | "mimeType" | "kind" | "hash" | "size" | "dataHash"
  >,
): Promise<MultimodalMemoryChunk | null> {
  const embeddingInput = await loadMultimodalEmbeddingInput(entry);
  if (!embeddingInput) {
    return null;
  }
  return {
    chunk: {
      startLine: 1,
      endLine: 1,
      text: entry.contentText ?? embeddingInput.text,
      hash: entry.hash,
      embeddingInput,
    },
    structuredInputBytes: estimateStructuredEmbeddingInputBytes(embeddingInput),
  };
}

export {
  extractProjectKeysFromCuratedEntry,
  INVALID_PROJECT_ANNOTATION_KEY,
  normalizeProjectAnnotationKey,
  stripMemoryAnnotationCarriers,
  type CuratedProjectAnnotations,
} from "./curated-annotations.js";

export function runMemoryHostTasksWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  return runWithConcurrencyImpl(tasks, limit);
}

export { runMemoryHostTasksWithConcurrency as runWithConcurrency };
