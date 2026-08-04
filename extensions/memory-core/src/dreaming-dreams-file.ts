// Memory Core helpers for safe managed DREAMS.md updates.
import { createReadStream, type Stats } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { createAsyncLock } from "openclaw/plugin-sdk/async-lock-runtime";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";
import {
  replaceManagedMarkdownBlock,
  withTrailingNewline,
} from "openclaw/plugin-sdk/memory-host-markdown";
import {
  openLocalFileSafely,
  readRegularFile,
  replaceFileAtomic,
} from "openclaw/plugin-sdk/security-runtime";

const DREAMS_FILENAMES = ["DREAMS.md", "dreams.md"] as const;
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
  heading: string;
  startMarker: string;
  endMarker: string;
  body: string;
  tempPrefix: string;
  allowSymlink?: boolean;
};

const dreamsFileLocks = resolveGlobalMap<string, DreamsFileLockEntry>(DREAMS_FILE_LOCKS_KEY);

export async function resolveDreamsPath(workspaceDir: string): Promise<string> {
  for (const name of DREAMS_FILENAMES) {
    const target = path.join(workspaceDir, name);
    try {
      await fs.access(target);
      return target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
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
): Promise<{ filePath: string; stat: Stats } | null> {
  const stat = await fs.lstat(filePath).catch((err: unknown) => {
    if (extractErrorCode(err) === "ENOENT") {
      return null;
    }
    throw err;
  });
  if (!stat) {
    return null;
  }
  const pathDescription = DREAMS_FILENAMES.includes(
    path.basename(filePath) as (typeof DREAMS_FILENAMES)[number],
  )
    ? "DREAMS.md"
    : `markdown file: ${filePath}`;
  if (stat.isSymbolicLink()) {
    if (!allowSymlink) {
      throw new Error(`Refusing to write symlinked ${pathDescription}`);
    }
    const resolvedPath = await fs.realpath(filePath);
    const resolvedStat = await fs.stat(resolvedPath);
    if (!resolvedStat.isFile()) {
      throw new Error(`Refusing to write non-file ${pathDescription}`);
    }
    return { filePath: resolvedPath, stat: resolvedStat };
  }
  if (!stat.isFile()) {
    throw new Error(`Refusing to write non-file ${pathDescription}`);
  }
  return { filePath, stat };
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
  const tempDir = await fs.mkdtemp(
    path.join(path.dirname(params.filePath), `${params.tempPrefix}-`),
  );
  const tempPath = path.join(tempDir, path.basename(params.filePath));
  let input: FileHandle | undefined;
  let output: FileHandle | undefined;
  const withheldPath = path.join(tempDir, `${path.basename(params.filePath)}.withheld`);
  let withheldFile: FileHandle | undefined;
  try {
    const opened = await openLocalFileSafely({ filePath: params.filePath });
    input = opened.handle;
    const inputSize = opened.stat.size;
    const mode = opened.stat.mode & 0o777;
    output = await fs.open(tempPath, "wx", mode);
    await output.chmod(mode);
    const managedBlock = buildManagedMarkdownBlock(params);
    const headingSuffixPattern = new RegExp(
      `${params.heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \t]*(?:\r\n|\n|\r)+[ \t]*$`,
    );
    const rollingWindowBytes =
      Math.max(params.heading.length + params.startMarker.length, params.endMarker.length) + 4096;
    let pending = "";
    let skipping = false;
    let wroteManagedBlock = false;
    let withheldHeadingSuffix = "";
    let wroteAnyContent = false;
    let outputBytes = 0;
    let lastNonWhitespaceEndBytes = 0;

    // Keep only a rolling marker window in memory. A malformed start marker
    // without an end marker is spooled so the original file can be replayed.
    const writeChunk = async (chunk: string): Promise<void> => {
      if (chunk.length > 0) {
        await output?.write(chunk);
        const trimmed = chunk.trimEnd();
        if (trimmed.length > 0) {
          lastNonWhitespaceEndBytes = outputBytes + Buffer.byteLength(trimmed);
        }
        outputBytes += Buffer.byteLength(chunk);
        wroteAnyContent = true;
      }
    };
    const writeWithheld = async (chunk: string): Promise<void> => {
      if (chunk.length === 0) {
        return;
      }
      withheldFile ??= await fs.open(withheldPath, "w");
      await withheldFile.write(chunk);
    };
    const clearWithheld = async (): Promise<void> => {
      await withheldFile?.close();
      withheldFile = undefined;
      await fs.rm(withheldPath, { force: true }).catch(() => undefined);
    };
    const replayWithheld = async (): Promise<void> => {
      await withheldFile?.close();
      withheldFile = undefined;
      try {
        for await (const chunk of createReadStream(withheldPath, { encoding: "utf-8" })) {
          await writeChunk(chunk);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      }
      await fs.rm(withheldPath, { force: true }).catch(() => undefined);
    };
    const writeManagedBlock = async (trailingText: string): Promise<void> => {
      await output?.write(managedBlock);
      if (!trailingText.startsWith("\n") && !trailingText.startsWith("\r")) {
        await output?.write("\n");
      }
      wroteManagedBlock = true;
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
          if (!wroteManagedBlock) {
            await writeManagedBlock(current.slice(afterEndIndex));
          }
          withheldHeadingSuffix = "";
          await clearWithheld();
          skipping = false;
          current = current.slice(afterEndIndex);
          continue;
        }

        const startIndex = current.indexOf(params.startMarker);
        if (startIndex < 0) {
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
        withheldHeadingSuffix = prefix.slice(trimmedPrefix.length);
        await writeChunk(trimmedPrefix);
        skipping = true;
        current = current.slice(startIndex);
        const endIndex = current.indexOf(params.endMarker);
        if (endIndex < 0) {
          const keep = Math.max(0, current.length - (params.endMarker.length - 1));
          await writeWithheld(current.slice(0, keep));
          pending = current.slice(keep);
          current = "";
          continue;
        }
        const afterEndIndex = endIndex + params.endMarker.length;
        if (!wroteManagedBlock) {
          await writeManagedBlock(current.slice(afterEndIndex));
        }
        withheldHeadingSuffix = "";
        await clearWithheld();
        skipping = false;
        current = current.slice(afterEndIndex);
      }
    }
    await input.close();
    input = undefined;
    if (skipping) {
      await writeChunk(withheldHeadingSuffix);
      await replayWithheld();
      await writeChunk(pending);
      pending = "";
    }
    await writeChunk(pending);
    if (!wroteManagedBlock) {
      await output.truncate(lastNonWhitespaceEndBytes);
      const separator = wroteAnyContent && lastNonWhitespaceEndBytes > 0 ? "\n\n" : "";
      await output.write(`${separator}${managedBlock}\n`, lastNonWhitespaceEndBytes, "utf-8");
    }
    await output.close();
    output = undefined;
    await fs.rename(tempPath, params.filePath);
  } catch (err) {
    await input?.close().catch(() => undefined);
    await output?.close().catch(() => undefined);
    await withheldFile?.close().catch(() => undefined);
    await fs.rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
    throw err;
  }
  await fs.rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
}

export async function updateManagedDreamingMarkdownFile(
  params: ManagedMarkdownUpdateParams,
): Promise<void> {
  await fs.mkdir(path.dirname(params.filePath), { recursive: true });
  // Daily memory files historically followed user-managed symlinks. Resolve
  // those links before atomic replacement so the link itself stays intact.
  const resolved = await resolveSafeMarkdownPath(params.filePath, params.allowSymlink === true);
  const resolvedParams = {
    ...params,
    filePath: resolved?.filePath ?? params.filePath,
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
      mode: 0o600,
      preserveExistingMode: true,
      tempPrefix: resolvedParams.tempPrefix,
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
  return await withDreamsFileLock(params.workspaceDir, async (dreamsPath) => {
    const existing = await readDreamsFile(dreamsPath);
    const { content, result, shouldWrite = true } = await params.updater(existing, dreamsPath);
    if (shouldWrite) {
      await writeDreamsFileAtomic(dreamsPath, content.endsWith("\n") ? content : `${content}\n`);
    }
    return result;
  });
}

export async function updateDeepDreamsFile(params: {
  workspaceDir: string;
  bodyLines: string[];
}): Promise<string> {
  const body = params.bodyLines.length > 0 ? params.bodyLines.join("\n") : "- No durable changes.";
  return await withDreamsFileLock(params.workspaceDir, async (dreamsPath) => {
    await updateManagedDreamingMarkdownFile({
      filePath: dreamsPath,
      heading: "## Deep Sleep",
      startMarker: DEEP_START_MARKER,
      endMarker: DEEP_END_MARKER,
      body,
      tempPrefix: `${path.basename(dreamsPath)}.dreams`,
    });
    return dreamsPath;
  });
}
