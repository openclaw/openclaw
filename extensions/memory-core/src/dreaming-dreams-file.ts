// Memory Core helpers for safe managed DREAMS.md updates.
import { createReadStream, type Stats } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAsyncLock } from "openclaw/plugin-sdk/async-lock-runtime";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";
import {
  replaceManagedMarkdownBlock,
  withTrailingNewline,
} from "openclaw/plugin-sdk/memory-host-markdown";
import {
  openLocalFileSafely,
  readRegularFile,
  replaceFileAtomic,
  root,
} from "openclaw/plugin-sdk/security-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";
import { readStore } from "./short-term-promotion-store.js";

export const DREAMS_FILENAMES = ["DREAMS.md", "dreams.md"] as const;
const DEEP_START_MARKER = "<!-- openclaw:dreaming:deep:start -->";
const DEEP_END_MARKER = "<!-- openclaw:dreaming:deep:end -->";
const DREAMS_FILE_LOCKS_KEY = Symbol.for("openclaw.memoryCore.dreamingNarrative.fileLocks");
const MEMORY_DREAMING_MARKDOWN_MAX_BYTES = 16 * 1024 * 1024;

type DreamsFileLockEntry = {
  withLock: ReturnType<typeof createAsyncLock>;
  refs: number;
};

type ManagedMarkdownUpdateParams = {
  filePath: string;
  expectedRealPath?: string;
  workspaceDir?: string;
  heading: string;
  startMarker: string;
  endMarker: string;
  body: string;
  tempPrefix: string;
  allowSymlink?: boolean;
  creationMode?: number;
};

const dreamsFileLocks = resolveGlobalMap<string, DreamsFileLockEntry>(DREAMS_FILE_LOCKS_KEY);

async function resolveDreamsPath(workspaceDir: string): Promise<string> {
  for (const name of DREAMS_FILENAMES) {
    const target = path.join(workspaceDir, name);
    try {
      await fs.access(target);
      return target;
    } catch (err) {
      if (extractErrorCode(err) !== "ENOENT") {
        throw err;
      }
    }
  }
  return path.join(workspaceDir, DREAMS_FILENAMES[0]);
}

function isEmptyDreamsReadError(err: unknown): boolean {
  const code = extractErrorCode(err);
  if (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "not-found" ||
    code === "not-file" ||
    code === "path-alias" ||
    code === "path-mismatch" ||
    code === "symlink"
  ) {
    return true;
  }
  return err instanceof Error && err.message === "path must be a regular file";
}

export async function readDreamsFile(dreamsPath: string): Promise<string> {
  try {
    return (await readRegularFile({ filePath: dreamsPath })).buffer.toString("utf-8");
  } catch (err) {
    if (isEmptyDreamsReadError(err)) {
      return "";
    }
    throw err;
  }
}

async function resolveSafeMarkdownPath(
  filePath: string,
  allowSymlink: boolean,
  workspaceDir?: string,
): Promise<{ filePath: string; realPath?: string; stat: Stats } | null> {
  const pathDescription = DREAMS_FILENAMES.includes(
    // SAFETY: basename is compared only against the literal DREAMS filename union.
    path.basename(filePath) as (typeof DREAMS_FILENAMES)[number],
  )
    ? "DREAMS.md"
    : `markdown file: ${filePath}`;
  let workspaceMemoryDir: string | undefined;
  if (allowSymlink) {
    if (!workspaceDir) {
      throw new Error(`Refusing to write ${pathDescription} without a workspace directory`);
    }
    const canonicalWorkspaceDir = await fs.realpath(workspaceDir);
    // Keep the configured memory directory itself as the lexical boundary.
    // Resolving it would make an external `memory` symlink the new trusted
    // root and defeat the containment check.
    workspaceMemoryDir = path.join(canonicalWorkspaceDir, "memory");
    const canonicalParent = await fs.realpath(path.dirname(filePath));
    if (!isPathInside(workspaceMemoryDir, canonicalParent)) {
      throw new Error(`Refusing to write ${pathDescription} outside workspace memory directory`);
    }
  }
  let canonicalFilePath: string | undefined;
  try {
    // Capture the canonical regular-file path before the lstat below. If the
    // pathname is swapped after this check, streaming will compare the opened
    // handle's real path with this captured value instead of following the
    // replacement pathname.
    canonicalFilePath = await fs.realpath(filePath);
  } catch (err) {
    if (extractErrorCode(err) !== "ENOENT") {
      throw err;
    }
  }
  const stat = await fs.lstat(filePath).catch((err: unknown) => {
    if (extractErrorCode(err) === "ENOENT") {
      return null;
    }
    throw err;
  });
  if (!stat) {
    return null;
  }
  if (stat.isSymbolicLink()) {
    if (!allowSymlink) {
      throw new Error(`Refusing to write symlinked ${pathDescription}`);
    }
    const resolvedPath = await fs.realpath(filePath);
    if (!workspaceMemoryDir || !isPathInside(workspaceMemoryDir, resolvedPath)) {
      throw new Error(`Refusing to write ${pathDescription} outside workspace memory directory`);
    }
    const resolvedStat = await fs.stat(resolvedPath);
    if (!resolvedStat.isFile()) {
      throw new Error(`Refusing to write non-file ${pathDescription}`);
    }
    return { filePath: resolvedPath, realPath: resolvedPath, stat: resolvedStat };
  }
  if (!stat.isFile()) {
    throw new Error(`Refusing to write non-file ${pathDescription}`);
  }
  return { filePath, realPath: canonicalFilePath, stat };
}

async function assertSafeDreamsPath(dreamsPath: string): Promise<void> {
  await resolveSafeMarkdownPath(dreamsPath, false);
}

async function writeDreamsFileAtomic(dreamsPath: string, content: string): Promise<void> {
  await assertSafeDreamsPath(dreamsPath);
  await replaceFileAtomic({
    filePath: dreamsPath,
    content,
    mode: 0o600,
    preserveExistingMode: true,
    tempPrefix: `${path.basename(dreamsPath)}.dreams`,
    throwOnCleanupError: true,
  });
}

function buildManagedMarkdownBlock(params: ManagedMarkdownUpdateParams): string {
  return `${params.heading}\n${params.startMarker}\n${params.body}\n${params.endMarker}`;
}

async function replaceManagedMarkdownBlockStreaming(
  params: ManagedMarkdownUpdateParams,
): Promise<void> {
  if (!params.workspaceDir) {
    throw new Error("Streaming managed Markdown replacement requires a workspace directory");
  }
  const canonicalWorkspaceDir = await fs.realpath(params.workspaceDir);
  const workspaceRoot = await root(canonicalWorkspaceDir);
  // resolveSafeMarkdownPath captures existing files' real paths before this
  // function starts. Keep that captured path; resolving it again here would
  // follow a pathname that may have been swapped after the containment check.
  const canonicalFilePath = params.expectedRealPath ?? params.filePath;
  if (!isPathInside(canonicalWorkspaceDir, canonicalFilePath)) {
    throw new Error("Refusing to stream a managed Markdown file outside the workspace");
  }
  const relativeTargetPath = path.relative(canonicalWorkspaceDir, canonicalFilePath);
  if (
    !relativeTargetPath ||
    relativeTargetPath === "." ||
    relativeTargetPath === ".." ||
    relativeTargetPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTargetPath)
  ) {
    throw new Error("Refusing to stream a managed Markdown file outside the workspace");
  }
  const relativeTargetPathForRoot = relativeTargetPath.split(path.sep).join(path.posix.sep);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `${params.tempPrefix}-`));
  const tempPath = path.join(tempDir, path.basename(canonicalFilePath));
  let input: FileHandle | undefined;
  let output: FileHandle | undefined;
  const withheldPath = path.join(tempDir, `${path.basename(canonicalFilePath)}.withheld`);
  let withheldFile: FileHandle | undefined;
  const describeError = (error: unknown): string => {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === "string") {
      return error;
    }
    return JSON.stringify(error) ?? "unknown error";
  };
  const cleanupTempDir = async (originalError?: unknown): Promise<void> => {
    try {
      await fs.rm(tempDir, { force: true, recursive: true });
    } catch (cleanupError) {
      if (originalError !== undefined) {
        throw new Error(
          `Streaming managed Markdown replacement failed (${describeError(originalError)}); ` +
            `temporary directory cleanup also failed (${describeError(cleanupError)})`,
          { cause: cleanupError },
        );
      }
      throw cleanupError;
    }
  };
  try {
    const opened = await openLocalFileSafely({ filePath: canonicalFilePath });
    input = opened.handle;
    if (opened.realPath !== canonicalFilePath) {
      throw new Error("Managed Markdown source path changed during streaming setup");
    }
    const inputSize = opened.stat.size;
    const mode = opened.stat.mode & 0o777;
    output = await fs.open(tempPath, "wx", mode);
    await output.chmod(mode);
    const managedBlock = buildManagedMarkdownBlock(params);
    // Mirror the shared SDK heading separator contract: one or more
    // whitespace-and-line-ending groups (including whitespace-only blank
    // lines) may separate the heading from the start marker.
    const headingSuffixPattern = new RegExp(
      `${params.heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[ \t]*(?:\r\n|\n|\r))+[ \t]*$`,
    );
    const rollingWindowBytes =
      Math.max(params.heading.length + params.startMarker.length, params.endMarker.length) + 4096;
    let pending = "";
    let skipping = false;
    let wroteManagedBlock = false;
    let withholdingHeadingSeparator = false;
    let withheldHeadingHasLineEnding = false;
    let wroteAnyContent = false;
    let outputBytes = 0;
    let outputEndsWithLf = false;
    let lastNonWhitespaceEndBytes = 0;
    let withheldBytes = 0;
    let duplicateGapStartBytes: number | undefined;
    let duplicateGapStartEndsWithLf = false;
    let duplicateGapIsWhitespace = true;
    let shouldDropDuplicateGap = false;

    const isLineWhitespace = (value: string): boolean => /^[\t \r\n]*$/.test(value);

    const writeAll = async (
      handle: FileHandle,
      buffer: Buffer,
      position: number,
      label: string,
    ): Promise<void> => {
      let written = 0;
      while (written < buffer.byteLength) {
        const { bytesWritten } = await handle.write(
          buffer,
          written,
          buffer.byteLength - written,
          position + written,
        );
        if (
          !Number.isInteger(bytesWritten) ||
          bytesWritten <= 0 ||
          bytesWritten > buffer.byteLength - written
        ) {
          throw new Error(`${label} write made invalid progress at byte ${position + written}`);
        }
        written += bytesWritten;
      }
    };

    // Keep only a rolling marker window in memory. A malformed start marker
    // without an end marker is spooled so the original file can be replayed.
    const writeChunk = async (chunk: string): Promise<void> => {
      if (chunk.length > 0) {
        if (!output) {
          throw new Error("Streaming managed Markdown output is not open");
        }
        const buffer = Buffer.from(chunk, "utf-8");
        await writeAll(output, buffer, outputBytes, "Streaming managed Markdown output");
        if (duplicateGapStartBytes !== undefined && !isLineWhitespace(chunk)) {
          duplicateGapIsWhitespace = false;
        }
        const trimmed = chunk.trimEnd();
        if (trimmed.length > 0) {
          lastNonWhitespaceEndBytes = outputBytes + Buffer.byteLength(trimmed);
        }
        outputBytes += Buffer.byteLength(chunk);
        outputEndsWithLf = chunk.endsWith("\n");
        wroteAnyContent = true;
      }
    };
    const writeWithheld = async (chunk: string): Promise<void> => {
      if (chunk.length === 0) {
        return;
      }
      withheldFile ??= await fs.open(withheldPath, "w");
      const buffer = Buffer.from(chunk, "utf-8");
      await writeAll(withheldFile, buffer, withheldBytes, "Withheld managed Markdown output");
      withheldBytes += buffer.byteLength;
    };
    const clearWithheld = async (): Promise<void> => {
      await withheldFile?.close();
      withheldFile = undefined;
      await fs.rm(withheldPath, { force: true });
      withheldBytes = 0;
    };
    const replayWithheld = async (): Promise<void> => {
      await withheldFile?.close();
      withheldFile = undefined;
      try {
        for await (const chunk of createReadStream(withheldPath, { encoding: "utf-8" })) {
          await writeChunk(chunk);
        }
      } catch (err) {
        // SAFETY: replay only suppresses a missing optional withheld spool.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      }
      await fs.rm(withheldPath, { force: true });
      withheldBytes = 0;
    };
    const writeManagedBlock = async (): Promise<void> => {
      await writeChunk(managedBlock);
      duplicateGapStartBytes = outputBytes;
      duplicateGapStartEndsWithLf = outputEndsWithLf;
      duplicateGapIsWhitespace = true;
      wroteManagedBlock = true;
    };
    const completeManagedBlock = async (): Promise<void> => {
      if (!wroteManagedBlock) {
        await writeManagedBlock();
        return;
      }
      if (shouldDropDuplicateGap && duplicateGapStartBytes !== undefined) {
        await output?.truncate(duplicateGapStartBytes);
        outputBytes = duplicateGapStartBytes;
        outputEndsWithLf = duplicateGapStartEndsWithLf;
        lastNonWhitespaceEndBytes = Math.min(lastNonWhitespaceEndBytes, outputBytes);
      }
      duplicateGapStartBytes = outputBytes;
      duplicateGapStartEndsWithLf = outputEndsWithLf;
      duplicateGapIsWhitespace = true;
      shouldDropDuplicateGap = false;
    };

    const inputStream =
      inputSize > 0
        ? input.createReadStream({
            encoding: "utf-8",
            autoClose: false,
            start: 0,
            end: inputSize - 1,
          })
        : [];
    for await (const chunk of inputStream) {
      let current = pending + chunk;
      pending = "";
      while (current.length > 0) {
        if (skipping) {
          const endIndex = current.indexOf(params.endMarker);
          if (endIndex < 0) {
            const keep = Math.max(0, current.length - (params.endMarker.length - 1));
            await writeWithheld(current.slice(0, keep));
            pending = current.slice(keep);
            current = "";
            continue;
          }
          const afterEndIndex = endIndex + params.endMarker.length;
          await completeManagedBlock();
          await clearWithheld();
          skipping = false;
          current = current.slice(afterEndIndex);
          continue;
        }

        if (withholdingHeadingSeparator) {
          const separatorEnd = current.search(/[^\t \r\n]/);
          const separator = separatorEnd < 0 ? current : current.slice(0, separatorEnd);
          if (separator.length > 0) {
            await writeWithheld(separator);
            withheldHeadingHasLineEnding ||= /[\r\n]/.test(separator);
            current = current.slice(separator.length);
          }
          if (current.length === 0) {
            continue;
          }
          if (!withheldHeadingHasLineEnding) {
            await replayWithheld();
            withholdingHeadingSeparator = false;
            continue;
          }
          if (current.startsWith(params.startMarker)) {
            await writeWithheld(params.startMarker);
            shouldDropDuplicateGap = wroteManagedBlock && duplicateGapIsWhitespace;
            withholdingHeadingSeparator = false;
            skipping = true;
            current = current.slice(params.startMarker.length);
            continue;
          }
          if (params.startMarker.startsWith(current)) {
            pending = current;
            current = "";
            continue;
          }
          await replayWithheld();
          withholdingHeadingSeparator = false;
          continue;
        }

        const startIndex = current.indexOf(params.startMarker);
        if (startIndex < 0) {
          const headingIndex = current.lastIndexOf(params.heading);
          if (headingIndex >= 0) {
            const headingSuffix = current.slice(headingIndex + params.heading.length);
            if (isLineWhitespace(headingSuffix)) {
              await writeChunk(current.slice(0, headingIndex));
              await writeWithheld(current.slice(headingIndex));
              withholdingHeadingSeparator = true;
              withheldHeadingHasLineEnding = /[\r\n]/.test(headingSuffix);
              current = "";
              continue;
            }
          }
          const keep = Math.max(0, current.length - rollingWindowBytes);
          await writeChunk(current.slice(0, keep));
          pending = current.slice(keep);
          current = "";
          continue;
        }

        const prefix = current.slice(0, startIndex);
        if (!headingSuffixPattern.test(prefix)) {
          // The shared SDK helper only replaces a managed block when the
          // configured heading directly precedes the start marker. A bare
          // marker pair is user content, so stream it through verbatim and
          // keep scanning for a heading-anchored block.
          const bareEnd = startIndex + params.startMarker.length;
          await writeChunk(current.slice(0, bareEnd));
          current = current.slice(bareEnd);
          continue;
        }
        const trimmedPrefix = prefix.replace(headingSuffixPattern, "");
        await writeChunk(trimmedPrefix);
        await writeWithheld(prefix.slice(trimmedPrefix.length));
        await writeWithheld(params.startMarker);
        shouldDropDuplicateGap = wroteManagedBlock && duplicateGapIsWhitespace;
        skipping = true;
        current = current.slice(startIndex + params.startMarker.length);
      }
    }
    await input.close();
    input = undefined;
    if (withholdingHeadingSeparator) {
      await replayWithheld();
    }
    if (skipping) {
      await replayWithheld();
      await writeChunk(pending);
      pending = "";
    }
    await writeChunk(pending);
    if (!wroteManagedBlock) {
      await output.truncate(lastNonWhitespaceEndBytes);
      outputBytes = lastNonWhitespaceEndBytes;
      outputEndsWithLf = false;
      const separator = wroteAnyContent && lastNonWhitespaceEndBytes > 0 ? "\n\n" : "";
      await writeChunk(`${separator}${managedBlock}\n`);
    } else if (!outputEndsWithLf) {
      await writeChunk("\n");
    }
    await output.sync();
    await output.close();
    output = undefined;
    // Commit through the root-relative writer. It pins traversal beneath the
    // checked workspace root and keeps a parent-directory swap from turning
    // the final write into an external pathname operation.
    await workspaceRoot.copyIn(relativeTargetPathForRoot, tempPath, {
      mode,
      mkdir: false,
      sourceHardlinks: "reject",
    });
  } catch (err) {
    await input?.close().catch(() => undefined);
    await output?.close().catch(() => undefined);
    await withheldFile?.close().catch(() => undefined);
    await cleanupTempDir(err);
    throw err;
  }
  await cleanupTempDir();
}

export async function updateManagedDreamingMarkdownFile(
  params: ManagedMarkdownUpdateParams,
): Promise<void> {
  await fs.mkdir(path.dirname(params.filePath), { recursive: true });
  // Daily memory files historically followed user-managed symlinks. Resolve
  // those links before atomic replacement so the link itself stays intact.
  const resolved = await resolveSafeMarkdownPath(
    params.filePath,
    params.allowSymlink === true,
    params.workspaceDir,
  );
  const resolvedParams = {
    ...params,
    filePath: resolved?.filePath ?? params.filePath,
    expectedRealPath: resolved?.realPath,
  };
  const stat = resolved?.stat ?? null;
  if (!stat || stat.size <= MEMORY_DREAMING_MARKDOWN_MAX_BYTES) {
    let original = "";
    if (stat) {
      original = (
        await readRegularFile({
          filePath: resolvedParams.filePath,
          maxBytes: MEMORY_DREAMING_MARKDOWN_MAX_BYTES,
        })
      ).buffer.toString("utf-8");
    }
    const updated = replaceManagedMarkdownBlock({ original, ...resolvedParams });
    await replaceFileAtomic({
      filePath: resolvedParams.filePath,
      content: withTrailingNewline(updated),
      mode: resolvedParams.creationMode ?? 0o600,
      preserveExistingMode: true,
      tempPrefix: resolvedParams.tempPrefix,
      syncTempFile: true,
      syncParentDir: true,
      throwOnCleanupError: true,
    });
    return;
  }
  await replaceManagedMarkdownBlockStreaming(resolvedParams);
}

async function withDreamsFileLock<T>(
  workspaceDir: string,
  fn: (dreamsPath: string) => Promise<T>,
): Promise<T> {
  const dreamsPath = await resolveDreamsPath(workspaceDir);
  await fs.mkdir(path.dirname(dreamsPath), { recursive: true });
  let lockEntry = dreamsFileLocks.get(dreamsPath);
  if (!lockEntry) {
    lockEntry = { withLock: createAsyncLock(), refs: 0 };
    dreamsFileLocks.set(dreamsPath, lockEntry);
  }
  lockEntry.refs += 1;
  try {
    return await lockEntry.withLock(() => fn(dreamsPath));
  } finally {
    lockEntry.refs -= 1;
    if (lockEntry.refs <= 0 && dreamsFileLocks.get(dreamsPath) === lockEntry) {
      dreamsFileLocks.delete(dreamsPath);
    }
  }
}

export async function updateDreamsFile<T>(params: {
  workspaceDir: string;
  updater: (
    existing: string,
    dreamsPath: string,
  ) =>
    | Promise<{ content: string; result: T; shouldWrite?: boolean }>
    | {
        content: string;
        result: T;
        shouldWrite?: boolean;
      };
}): Promise<T> {
  // Read and replace under the purge owner's lock so an awaited diary update
  // cannot write a pre-deletion file snapshot back over the scrubbed contents.
  return await withMemoryWorkspaceLock(
    params.workspaceDir,
    async () =>
      await withDreamsFileLock(params.workspaceDir, async (dreamsPath) => {
        const existing = await readDreamsFile(dreamsPath);
        const { content, result, shouldWrite = true } = await params.updater(existing, dreamsPath);
        if (shouldWrite) {
          await writeDreamsFileAtomic(
            dreamsPath,
            content.endsWith("\n") ? content : `${content}\n`,
          );
        }
        return result;
      }),
  );
}

export async function updateDeepDreamsFile(params: {
  workspaceDir: string;
  bodyLines: string[];
}): Promise<string> {
  const body = params.bodyLines.length > 0 ? params.bodyLines.join("\n") : "- No durable changes.";
  return await withMemoryWorkspaceLock(
    params.workspaceDir,
    async () =>
      await withDreamsFileLock(params.workspaceDir, async (dreamsPath) => {
        await updateManagedDreamingMarkdownFile({
          filePath: dreamsPath,
          workspaceDir: params.workspaceDir,
          heading: "## Deep Sleep",
          startMarker: DEEP_START_MARKER,
          endMarker: DEEP_END_MARKER,
          body,
          tempPrefix: `${path.basename(dreamsPath)}.dreams`,
        });
        return dreamsPath;
      }),
  );
}

const DIARY_START_MARKER = "<!-- openclaw:dreaming:diary:start -->";
const DIARY_END_MARKER = "<!-- openclaw:dreaming:diary:end -->";
const BACKFILL_ENTRY_MARKER = "openclaw:dreaming:backfill-entry";
const RECENT_DIARY_CONTEXT_LIMIT = 3;
const RECENT_DIARY_CONTEXT_MAX_CHARS = 360;

// ── Date formatting ────────────────────────────────────────────────────

function formatNarrativeDate(epochMs: number, timezone?: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: timezone ?? process.env.TZ,
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    // Always include the timezone abbreviation so the reader knows which
    // timezone the timestamp refers to.  Without this, users who haven't
    // configured a timezone see bare times that look local but are actually
    // UTC, causing confusion (see #65027).
    timeZoneName: "short",
  };
  return new Intl.DateTimeFormat("en-US", opts).format(new Date(epochMs));
}

// ── DREAMS.md file I/O ─────────────────────────────────────────────────

function ensureDiarySection(existing: string): string {
  if (existing.includes(DIARY_START_MARKER) && existing.includes(DIARY_END_MARKER)) {
    return existing;
  }
  const diarySection = `# Dream Diary\n\n${DIARY_START_MARKER}\n${DIARY_END_MARKER}\n`;
  if (existing.trim().length === 0) {
    return diarySection;
  }
  return diarySection + "\n" + existing;
}

function replaceDiaryContent(existing: string, diaryContent: string): string {
  const ensured = ensureDiarySection(existing);
  const startIdx = ensured.indexOf(DIARY_START_MARKER);
  const endIdx = ensured.indexOf(DIARY_END_MARKER);
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
    return ensured;
  }
  const before = ensured.slice(0, startIdx + DIARY_START_MARKER.length);
  const after = ensured.slice(endIdx);
  const normalized = diaryContent.trim().length > 0 ? `\n${diaryContent.trim()}\n` : "\n";
  return before + normalized + after;
}

function splitDiaryBlocks(diaryContent: string): string[] {
  return diaryContent
    .split(/\n---\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

export function clampDreamDiaryContextEntry(entry: string): string {
  const normalized = entry.replace(/\s+/g, " ").trim();
  if (normalized.length <= RECENT_DIARY_CONTEXT_MAX_CHARS) {
    return normalized;
  }
  return `${truncateUtf16Safe(normalized, RECENT_DIARY_CONTEXT_MAX_CHARS).trimEnd()}...`;
}

function normalizeDiaryBlockBody(block: string): string {
  const bodyLines: string[] = [];
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("<!--") || trimmed.startsWith("#")) {
      continue;
    }
    if (trimmed.startsWith("*") && trimmed.endsWith("*") && trimmed.length > 2) {
      continue;
    }
    bodyLines.push(trimmed);
  }
  return clampDreamDiaryContextEntry(bodyLines.join(" "));
}

function isOptionalDiaryContextReadError(err: unknown): boolean {
  const code = extractErrorCode(err);
  if (
    code === "EACCES" ||
    code === "EPERM" ||
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "not-found" ||
    code === "not-file" ||
    code === "path-alias" ||
    code === "path-mismatch" ||
    code === "symlink"
  ) {
    return true;
  }
  return err instanceof Error && err.message === "path must be a regular file";
}

function getDiaryContextEntries(existing: string): string[] {
  const startIdx = existing.indexOf(DIARY_START_MARKER);
  const endIdx = existing.indexOf(DIARY_END_MARKER);
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
    return [];
  }
  const inner = existing.slice(startIdx + DIARY_START_MARKER.length, endIdx);
  return splitDiaryBlocks(inner)
    .map(normalizeDiaryBlockBody)
    .filter((entry) => entry.length > 0);
}

export async function readRecentDreamDiaryEntries(params: {
  workspaceDir: string;
  limit?: number;
}): Promise<string[]> {
  const limit = Math.max(0, Math.floor(params.limit ?? RECENT_DIARY_CONTEXT_LIMIT));
  if (limit === 0) {
    return [];
  }
  let existing: string;
  try {
    const dreamsPath = await resolveDreamsPath(params.workspaceDir);
    existing = await readDreamsFile(dreamsPath);
  } catch (err) {
    if (isOptionalDiaryContextReadError(err)) {
      return [];
    }
    throw err;
  }
  return getDiaryContextEntries(existing).slice(-limit).toReversed();
}

function normalizeDiaryBlockFingerprint(block: string): string {
  const lines = block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let dateLine = "";
  const bodyLines: string[] = [];
  for (const line of lines) {
    if (!dateLine && line.startsWith("*") && line.endsWith("*") && line.length > 2) {
      dateLine = line.slice(1, -1).trim();
      continue;
    }
    if (line.startsWith("<!--") || line.startsWith("#")) {
      continue;
    }
    bodyLines.push(line);
  }
  const normalizedDate = dateLine.replace(/\s+/g, " ").trim();
  const normalizedBody = bodyLines
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  return `${normalizedDate}\n${normalizedBody}`;
}

function joinDiaryBlocks(blocks: string[]): string {
  if (blocks.length === 0) {
    return "";
  }
  return blocks.map((block) => `---\n\n${block.trim()}\n`).join("\n");
}

function stripBackfillDiaryBlocks(existing: string): { updated: string; removed: number } {
  const ensured = ensureDiarySection(existing);
  const startIdx = ensured.indexOf(DIARY_START_MARKER);
  const endIdx = ensured.indexOf(DIARY_END_MARKER);
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
    return { updated: ensured, removed: 0 };
  }
  const inner = ensured.slice(startIdx + DIARY_START_MARKER.length, endIdx);
  const kept: string[] = [];
  let removed = 0;
  for (const block of splitDiaryBlocks(inner)) {
    if (block.includes(BACKFILL_ENTRY_MARKER)) {
      removed += 1;
      continue;
    }
    kept.push(block);
  }
  return {
    updated: replaceDiaryContent(ensured, joinDiaryBlocks(kept)),
    removed,
  };
}

function formatBackfillDiaryDate(isoDay: string, _timezone?: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
  if (!match) {
    return isoDay;
  }
  const [, year, month, day] = match;
  const opts: Intl.DateTimeFormatOptions = {
    // Preserve the source iso day exactly; backfill labels should not drift by timezone.
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  };
  const epochMs = Date.UTC(Number(year), Number(month) - 1, Number(day), 12);
  return new Intl.DateTimeFormat("en-US", opts).format(new Date(epochMs));
}

function buildBackfillDiaryEntry(params: {
  isoDay: string;
  bodyLines: string[];
  sourcePath?: string;
  timezone?: string;
}): string {
  const dateStr = formatBackfillDiaryDate(params.isoDay, params.timezone);
  const marker = `<!-- ${BACKFILL_ENTRY_MARKER} day=${params.isoDay}${params.sourcePath ? ` source=${params.sourcePath}` : ""} -->`;
  const body = params.bodyLines
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  return [`*${dateStr}*`, marker, body].filter((part) => part.length > 0).join("\n\n");
}

export async function writeBackfillDiaryEntries(params: {
  workspaceDir: string;
  entries: Array<{
    isoDay: string;
    bodyLines: string[];
    sourcePath?: string;
  }>;
  preserveExisting?: boolean;
  timezone?: string;
}): Promise<{ dreamsPath: string; written: number; replaced: number }> {
  return await updateDreamsFile({
    workspaceDir: params.workspaceDir,
    updater: (existing, dreamsPath) => {
      const stripped = params.preserveExisting
        ? { updated: existing, removed: 0 }
        : stripBackfillDiaryBlocks(existing);
      const startIdx = stripped.updated.indexOf(DIARY_START_MARKER);
      const endIdx = stripped.updated.indexOf(DIARY_END_MARKER);
      const inner =
        startIdx >= 0 && endIdx > startIdx
          ? stripped.updated.slice(startIdx + DIARY_START_MARKER.length, endIdx)
          : "";
      const preservedBlocks = splitDiaryBlocks(inner);
      const additions = params.entries.map((entry) =>
        buildBackfillDiaryEntry({
          isoDay: entry.isoDay,
          bodyLines: entry.bodyLines,
          sourcePath: entry.sourcePath,
          timezone: params.timezone,
        }),
      );
      const existingFingerprints = new Set(
        preservedBlocks.map((block) => normalizeDiaryBlockFingerprint(block)),
      );
      const appended = params.preserveExisting
        ? additions.filter((block) => {
            const fingerprint = normalizeDiaryBlockFingerprint(block);
            if (existingFingerprints.has(fingerprint)) {
              return false;
            }
            existingFingerprints.add(fingerprint);
            return true;
          })
        : additions;
      const nextBlocks = [...preservedBlocks, ...appended];
      return {
        content: replaceDiaryContent(stripped.updated, joinDiaryBlocks(nextBlocks)),
        result: {
          dreamsPath,
          written: appended.length,
          replaced: stripped.removed,
        },
      };
    },
  });
}

export async function removeBackfillDiaryEntries(params: {
  workspaceDir: string;
}): Promise<{ dreamsPath: string; removed: number }> {
  return await updateDreamsFile({
    workspaceDir: params.workspaceDir,
    updater: (existing, dreamsPath) => {
      const stripped = stripBackfillDiaryBlocks(existing);
      return {
        content: stripped.updated,
        result: {
          dreamsPath,
          removed: stripped.removed,
        },
        shouldWrite: stripped.removed > 0 || existing.length > 0,
      };
    },
  });
}

export async function dedupeDreamDiaryEntries(params: {
  workspaceDir: string;
}): Promise<{ dreamsPath: string; removed: number; kept: number }> {
  return await updateDreamsFile({
    workspaceDir: params.workspaceDir,
    updater: (existing, dreamsPath) => {
      const ensured = ensureDiarySection(existing);
      const startIdx = ensured.indexOf(DIARY_START_MARKER);
      const endIdx = ensured.indexOf(DIARY_END_MARKER);
      if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
        return {
          content: ensured,
          result: { dreamsPath, removed: 0, kept: 0 },
          shouldWrite: false,
        };
      }
      const inner = ensured.slice(startIdx + DIARY_START_MARKER.length, endIdx);
      const blocks = splitDiaryBlocks(inner);
      const seen = new Set<string>();
      const keptBlocks: string[] = [];
      let removed = 0;
      for (const block of blocks) {
        const fingerprint = normalizeDiaryBlockFingerprint(block);
        if (seen.has(fingerprint)) {
          removed += 1;
          continue;
        }
        seen.add(fingerprint);
        keptBlocks.push(block);
      }
      return {
        content: replaceDiaryContent(ensured, joinDiaryBlocks(keptBlocks)),
        result: {
          dreamsPath,
          removed,
          kept: keptBlocks.length,
        },
        shouldWrite: removed > 0,
      };
    },
  });
}

function buildDiaryEntry(narrative: string, dateStr: string): string {
  return `\n---\n\n*${dateStr}*\n\n${narrative}\n`;
}

export async function appendNarrativeEntry(params: {
  workspaceDir: string;
  narrative: string;
  nowMs: number;
  timezone?: string;
  sourceEntryKeys?: readonly string[];
  recentDiaryEntries?: readonly string[];
}): Promise<string | undefined> {
  const dateStr = formatNarrativeDate(params.nowMs, params.timezone);
  const entry = buildDiaryEntry(params.narrative, dateStr);
  return await updateDreamsFile<string | undefined>({
    workspaceDir: params.workspaceDir,
    updater: async (existing, dreamsPath) => {
      const sourceKeys = params.sourceEntryKeys ?? [];
      const currentSources =
        sourceKeys.length > 0
          ? (await readStore(params.workspaceDir, new Date(params.nowMs).toISOString())).entries
          : undefined;
      const currentDiary = new Set(getDiaryContextEntries(existing));
      // The updater holds the purge lock. Model work ran outside it, so both
      // staged inputs and prior diary quotes must survive until this commit.
      if (
        sourceKeys.some((key) => !currentSources?.[key]) ||
        params.recentDiaryEntries?.some(
          (block) => !currentDiary.has(clampDreamDiaryContextEntry(block)),
        )
      ) {
        return { content: existing, result: undefined, shouldWrite: false };
      }
      let updated: string;
      if (existing.includes(DIARY_START_MARKER) && existing.includes(DIARY_END_MARKER)) {
        const endIdx = existing.lastIndexOf(DIARY_END_MARKER);
        updated = existing.slice(0, endIdx) + entry + "\n" + existing.slice(endIdx);
      } else if (existing.includes(DIARY_START_MARKER)) {
        const startIdx = existing.indexOf(DIARY_START_MARKER) + DIARY_START_MARKER.length;
        updated =
          existing.slice(0, startIdx) +
          entry +
          "\n" +
          DIARY_END_MARKER +
          "\n" +
          existing.slice(startIdx);
      } else {
        const diarySection = `# Dream Diary\n\n${DIARY_START_MARKER}${entry}\n${DIARY_END_MARKER}\n`;
        updated = existing.trim().length === 0 ? diarySection : `${diarySection}\n${existing}`;
      }
      return { content: updated, result: dreamsPath };
    },
  });
}
