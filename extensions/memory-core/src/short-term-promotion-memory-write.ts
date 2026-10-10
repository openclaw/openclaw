import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import {
  resolvePathPrefixSync,
  writeFileWindowFully,
} from "openclaw/plugin-sdk/file-access-runtime";
import type { MemoryWorkspaceFiles } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { replaceFileAtomic } from "openclaw/plugin-sdk/security-runtime";
import { getMemoryWorkspaceMaintenance, readWorkspaceText } from "./memory-workspace-files.js";

type MemoryFileCommit = Parameters<
  NonNullable<MemoryWorkspaceFiles["maintenance"]>["commitContent"]
>[0];

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

// Promotion and forget rewrite the whole file from decoded text, so admitting
// bytes that only decode with replacement would persist U+FFFD over content the
// write never intended to touch (same rule as the edit/apply_patch tools, see
// src/agents/utf8-file.ts). Refuse before any write instead.
export class MemoryFileNotUtf8Error extends Error {
  constructor(filePath: string) {
    super(
      `Memory file is not valid UTF-8 and cannot be rewritten safely: ${filePath}. ` +
        "The file was left unchanged. Keep a byte-for-byte backup, convert a copy to UTF-8 with its original encoding, then retry.",
    );
    this.name = "MemoryFileNotUtf8Error";
  }
}

/** Read the current bytes of a memory file, tolerating a missing file. */
async function readMemoryBytesIfPresent(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if (extractErrorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function assertMemoryFileUtf8(filePath: string, bytes: Buffer | null): void {
  if (bytes && !isUtf8(bytes)) {
    throw new MemoryFileNotUtf8Error(filePath);
  }
}

export async function resolveMemoryWritePath(
  filePath: string,
  workspaceDir?: string,
): Promise<string> {
  const files = workspaceDir ? getMemoryWorkspaceMaintenance(workspaceDir) : undefined;
  if (files) {
    return await files.resolveWritePath(filePath);
  }
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

export async function readMemoryContent(filePath: string, workspaceDir?: string): Promise<string> {
  return await (
    workspaceDir ? readWorkspaceText(workspaceDir, filePath) : fs.readFile(filePath, "utf-8")
  ).catch((error: unknown) => {
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
  const existingBytes = await readMemoryBytesIfPresent(params.filePath);
  assertMemoryFileUtf8(params.filePath, existingBytes);
  if ((existingBytes ? existingBytes.toString("utf8") : "") !== params.expectedContent) {
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
      await writeFileWindowFully(handle, original, 0);
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

export async function commitMemoryContent(
  params: MemoryFileCommit & { workspaceDir?: string },
): Promise<void> {
  const files = params.workspaceDir
    ? getMemoryWorkspaceMaintenance(params.workspaceDir)
    : undefined;
  if (files) {
    const { workspaceDir: _workspaceDir, ...request } = params;
    try {
      return await files.commitContent(request);
    } catch (error) {
      // Preserve the native caller's conflict and publication handling across IPC.
      if (error instanceof Error && error.name === "MemoryWriteConflictError") {
        throw new MemoryWriteConflictError(error.message);
      }
      if (
        error &&
        typeof error === "object" &&
        "publication" in error &&
        (error.publication === "uncertain" || error.publication === "committed")
      ) {
        throw new MemoryAtomicPublicationError(error.publication, error);
      }
      throw error;
    }
  }
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
  // The merged content is derived from decoded text; refuse up front when the
  // bytes on disk do not decode cleanly so the rewrite cannot persist U+FFFD
  // over unrelated content. beforeRename repeats the admission to close the
  // window between this check and the rename.
  assertMemoryFileUtf8(params.filePath, await readMemoryBytesIfPresent(params.filePath));
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
        const currentBytes = await readMemoryBytesIfPresent(params.filePath);
        assertMemoryFileUtf8(params.filePath, currentBytes);
        if (
          params.expectedHash &&
          hashMemoryContent(currentBytes ? currentBytes.toString("utf8") : "") !==
            params.expectedHash
        ) {
          throw new MemoryWriteConflictError(params.conflictMessage);
        }
        // OpenClaw writers are serialized. The recoverable preimage covers the
        // accepted race with external editors between this check and rename.
      },
      fileSystem: {
        promises: {
          ...fs,
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
