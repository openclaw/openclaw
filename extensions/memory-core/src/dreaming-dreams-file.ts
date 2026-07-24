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
import { readRegularFile, replaceFileAtomic } from "openclaw/plugin-sdk/security-runtime";

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
};

const dreamsFileLocks = resolveGlobalMap<string, DreamsFileLockEntry>(DREAMS_FILE_LOCKS_KEY);

function rethrowDreamingMarkdownReadError(err: unknown, filePath: string): never {
  if (extractErrorCode(err) === "too-large") {
    throw new Error(
      `Dreaming left ${filePath} unchanged because it exceeds ${MEMORY_DREAMING_MARKDOWN_MAX_BYTES} bytes. ` +
        "Archive or split the file below 16 MiB, then retry.",
      { cause: err },
    );
  }
  throw err;
}

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
    return (
      await readRegularFile({
        filePath: dreamsPath,
        maxBytes: MEMORY_DREAMING_MARKDOWN_MAX_BYTES,
      })
    ).buffer.toString("utf-8");
  } catch (err) {
    if (isEmptyDreamsReadError(err)) {
      return "";
    }
    return rethrowDreamingMarkdownReadError(err, dreamsPath);
  }
}

async function statSafeMarkdownPath(filePath: string): Promise<Stats | null> {
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
    throw new Error(`Refusing to write symlinked ${pathDescription}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Refusing to write non-file ${pathDescription}`);
  }
  return stat;
}

async function assertSafeDreamsPath(dreamsPath: string): Promise<void> {
  await statSafeMarkdownPath(dreamsPath);
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
  params: ManagedMarkdownUpdateParams & { mode: number },
): Promise<void> {
  const tempDir = await fs.mkdtemp(
    path.join(path.dirname(params.filePath), `${params.tempPrefix}-`),
  );
  const tempPath = path.join(tempDir, path.basename(params.filePath));
  let output: FileHandle | undefined;
  const withheldPath = path.join(tempDir, `${path.basename(params.filePath)}.withheld`);
  let withheldFile: FileHandle | undefined;
  try {
    output = await fs.open(tempPath, "wx", params.mode);
    await output.chmod(params.mode);
    const managedBlock = buildManagedMarkdownBlock(params);
    const headingSuffixPattern = new RegExp(
      `${params.heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \t]*(?:\r\n|\n|\r)+[ \t]*$`,
    );
    const rollingWindowBytes =
      Math.max(params.heading.length + params.startMarker.length, params.endMarker.length) + 4096;
    let pending = "";
    let skipping = false;
    let sawManagedBlock = false;
    let wroteManagedBlock = false;
    let withheldHeadingSuffix = "";
    let wroteAnyContent = false;

    // Keep only a rolling marker window in memory. A malformed start marker
    // without an end marker is spooled so the original file can be replayed.
    const writeChunk = async (chunk: string): Promise<void> => {
      if (chunk.length > 0) {
        await output?.write(chunk);
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
      if (
        trailingText.length > 0 &&
        !trailingText.startsWith("\n") &&
        !trailingText.startsWith("\r")
      ) {
        await output?.write("\n");
      }
      wroteManagedBlock = true;
    };

    for await (const chunk of createReadStream(params.filePath, { encoding: "utf-8" })) {
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

        sawManagedBlock = true;
        const prefix = current.slice(0, startIndex);
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
    if (skipping) {
      await writeChunk(withheldHeadingSuffix);
      await replayWithheld();
      await writeChunk(pending);
      pending = "";
    }
    await writeChunk(pending);
    if (!sawManagedBlock) {
      if (wroteAnyContent) {
        await output.write("\n\n");
      }
      await output.write(`${managedBlock}\n`);
    }
    await output.close();
    output = undefined;
    await fs.rename(tempPath, params.filePath);
  } catch (err) {
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
  const stat = await statSafeMarkdownPath(params.filePath);
  if (!stat || stat.size <= MEMORY_DREAMING_MARKDOWN_MAX_BYTES) {
    let original = "";
    if (stat) {
      original = (
        await readRegularFile({
          filePath: params.filePath,
          maxBytes: MEMORY_DREAMING_MARKDOWN_MAX_BYTES,
        })
      ).buffer.toString("utf-8");
    }
    const updated = replaceManagedMarkdownBlock({ original, ...params });
    await replaceFileAtomic({
      filePath: params.filePath,
      content: withTrailingNewline(updated),
      mode: 0o600,
      preserveExistingMode: true,
      tempPrefix: params.tempPrefix,
      throwOnCleanupError: true,
    });
    return;
  }
  await replaceManagedMarkdownBlockStreaming({ ...params, mode: stat.mode & 0o777 });
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
  const dreamsPath = await resolveDreamsPath(params.workspaceDir);
  await fs.mkdir(path.dirname(dreamsPath), { recursive: true });
  let lockEntry = dreamsFileLocks.get(dreamsPath);
  if (!lockEntry) {
    lockEntry = { withLock: createAsyncLock(), refs: 0 };
    dreamsFileLocks.set(dreamsPath, lockEntry);
  }
  lockEntry.refs += 1;
  try {
    return await lockEntry.withLock(async () => {
      const existing = await readDreamsFile(dreamsPath);
      const { content, result, shouldWrite = true } = await params.updater(existing, dreamsPath);
      if (shouldWrite) {
        await writeDreamsFileAtomic(dreamsPath, content.endsWith("\n") ? content : `${content}\n`);
      }
      return result;
    });
  } finally {
    lockEntry.refs -= 1;
    if (lockEntry.refs <= 0 && dreamsFileLocks.get(dreamsPath) === lockEntry) {
      dreamsFileLocks.delete(dreamsPath);
    }
  }
}

export async function updateDeepDreamsFile(params: {
  workspaceDir: string;
  bodyLines: string[];
}): Promise<string> {
  const body = params.bodyLines.length > 0 ? params.bodyLines.join("\n") : "- No durable changes.";
  const dreamsPath = await resolveDreamsPath(params.workspaceDir);
  await updateManagedDreamingMarkdownFile({
    filePath: dreamsPath,
    heading: "## Deep Sleep",
    startMarker: DEEP_START_MARKER,
    endMarker: DEEP_END_MARKER,
    body,
    tempPrefix: `${path.basename(dreamsPath)}.dreams`,
  });
  return dreamsPath;
}
