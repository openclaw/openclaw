import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { resolvePathPrefixSync } from "openclaw/plugin-sdk/file-access-runtime";
import { replaceFileAtomic } from "openclaw/plugin-sdk/security-runtime";

export function buildPromotionMarker(candidateKey: string): string {
  return `<!-- openclaw-memory-promotion:${candidateKey} -->`;
}

export function extractPromotionKeys(content: string): string[] {
  // Source paths can contain spaces; the comment boundary terminates a key.
  return [...content.matchAll(/<!--\s*openclaw-memory-promotion:([^\n]*?)\s*-->/giu)]
    .map((match) => match[1]?.trim())
    .filter((key): key is string => Boolean(key));
}

export class MemoryWriteConflictError extends Error {
  constructor(message = "MEMORY.md changed before the dreaming write could commit") {
    super(message);
    this.name = "MemoryWriteConflictError";
  }
}

export class MemoryAtomicPublicationError extends Error {
  readonly code: ReturnType<typeof extractErrorCode>;

  constructor(
    readonly publication: "uncertain" | "committed",
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = cause instanceof Error ? cause.name : "Error";
    this.code = extractErrorCode(cause);
  }
}

export async function resolveMemoryWritePath(filePath: string): Promise<string> {
  // Keep existing-file lookups asynchronous where realpath preserves physical traversal.
  if (!process.versions.bun || process.platform === "win32") {
    try {
      return await fs.realpath(filePath);
    } catch (error) {
      if (extractErrorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }
  const { existingPath, unresolvedSegments } = resolvePathPrefixSync(filePath);
  if (unresolvedSegments.length === 0) {
    return existingPath;
  }
  // Only the leaf may be missing; retain unresolved dots and trailing separators.
  if (unresolvedSegments.length !== 1) {
    throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${filePath}'`), {
      code: "ENOENT",
      path: filePath,
      syscall: "realpath",
    });
  }
  return path.join(existingPath, unresolvedSegments[0]!);
}

export async function readMemoryContent(filePath: string): Promise<string> {
  return await fs.readFile(filePath, "utf-8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  });
}

export function isAtomicReplacePermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM" || code === "EEXIST" || code === "EROFS";
}

async function writeExistingMemoryInPlace(params: {
  filePath: string;
  expectedContent: string;
  content: string;
  conflictMessage?: string;
}): Promise<boolean> {
  if ((await readMemoryContent(params.filePath)) !== params.expectedContent) {
    throw new MemoryWriteConflictError(params.conflictMessage);
  }
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(params.filePath, "r+");
  } catch {
    return false;
  }
  try {
    await handle.writeFile(params.content, { encoding: "utf-8" });
    await handle.truncate(Buffer.byteLength(params.content));
    await handle.sync();
    return true;
  } catch (error) {
    const original = Buffer.from(params.expectedContent, "utf-8");
    try {
      let restored = 0;
      while (restored < original.length) {
        const { bytesWritten } = await handle.write(
          original,
          restored,
          original.length - restored,
          restored,
        );
        if (bytesWritten <= 0) {
          throw new Error(`${path.basename(params.filePath)} restore write made no progress`, {
            cause: error,
          });
        }
        restored += bytesWritten;
      }
      await handle.truncate(original.length);
      await handle.sync();
    } catch (restoreError) {
      throw new Error(
        `${path.basename(params.filePath)} in-place write failed and restoring the original content also failed`,
        { cause: restoreError },
      );
    }
    throw error;
  } finally {
    await handle.close();
  }
}

export function hashMemoryContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

type MemoryContentCommit =
  | { content: string; expectedContent?: string }
  | { content: null; expectedContent: string };

export async function commitMemoryContent(
  params: {
    filePath: string;
    tempPrefix: string;
    expectedHash?: string;
    allowInPlaceFallback?: boolean;
    conflictMessage?: string;
  } & MemoryContentCommit,
): Promise<void> {
  if (params.content === null) {
    if ((await readMemoryContent(params.filePath)) !== params.expectedContent) {
      throw new MemoryWriteConflictError(params.conflictMessage);
    }
    // Unlink is atomic; the preimage check preserves external edits made after planning.
    await fs.unlink(params.filePath);
    return;
  }
  const memoryDirMode = (await fs.stat(path.dirname(params.filePath))).mode & 0o7777;
  const expectedHash = params.expectedHash;
  const replacementContent = params.content;
  const publication: {
    state: "unattempted" | "unchanged-after-rejection" | "uncertain" | "committed";
  } = { state: "unattempted" };
  try {
    await replaceFileAtomic({
      filePath: params.filePath,
      content: params.content,
      dirMode: memoryDirMode,
      mode: 0o600,
      preserveExistingMode: true,
      tempPrefix: params.tempPrefix,
      syncTempFile: true,
      syncParentDir: true,
      throwOnCleanupError: true,
      beforeRename: async () => {
        if (
          params.expectedHash &&
          hashMemoryContent(await readMemoryContent(params.filePath)) !== params.expectedHash
        ) {
          throw new MemoryWriteConflictError(params.conflictMessage);
        }
        // OpenClaw writers are serialized. The recoverable preimage covers the
        // accepted race with external editors between this check and rename.
      },
      fileSystem: {
        promises: {
          mkdir: fs.mkdir,
          chmod: fs.chmod,
          writeFile: fs.writeFile,
          rename: async (from, to) => {
            publication.state = "uncertain";
            try {
              await fs.rename(from, to);
            } catch (error) {
              if (
                isAtomicReplacePermissionError(error) &&
                expectedHash &&
                hashMemoryContent(replacementContent) !== expectedHash
              ) {
                // Errno alone proves no outcome. Reconcile this rejected rename's target.
                try {
                  if (hashMemoryContent(await readMemoryContent(String(to))) === expectedHash) {
                    publication.state = "unchanged-after-rejection";
                  }
                } catch {
                  // An unavailable preimage leaves the dispatched mutation uncertain.
                }
              }
              throw error;
            }
            publication.state = "committed";
          },
          copyFile: fs.copyFile,
          unlink: fs.unlink,
          rm: fs.rm,
          open: fs.open,
          stat: fs.stat,
          lstat: fs.lstat,
        },
      },
    });
  } catch (error) {
    // Append-only promotion retains the shipped writable-file fallback when
    // directory ACLs block temp-file replacement; consolidation never uses it.
    if (
      !params.allowInPlaceFallback ||
      params.expectedContent === undefined ||
      !isAtomicReplacePermissionError(error) ||
      !(await writeExistingMemoryInPlace({
        filePath: params.filePath,
        expectedContent: params.expectedContent,
        content: params.content,
        conflictMessage: params.conflictMessage,
      }))
    ) {
      if (publication.state === "uncertain" || publication.state === "committed") {
        throw new MemoryAtomicPublicationError(publication.state, error);
      }
      throw error;
    }
  }
}
