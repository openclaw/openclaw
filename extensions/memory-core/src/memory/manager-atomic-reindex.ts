// Memory Core plugin module implements manager atomic reindex behavior.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

type MemoryIndexFileOps = {
  rename: typeof fs.rename;
  rm: typeof fs.rm;
  wait: (ms: number) => Promise<void>;
};

type MemoryIndexFileOptions = {
  fileOps?: MemoryIndexFileOps;
  maxRenameAttempts?: number;
  renameRetryDelayMs?: number;
  maxRemoveAttempts?: number;
  removeRetryDelayMs?: number;
};

type ResolvedMemoryIndexFileOptions = Required<MemoryIndexFileOptions>;

const defaultFileOps: MemoryIndexFileOps = {
  rename: fs.rename,
  rm: fs.rm,
  wait: sleep,
};

const transientFileErrorCodes = new Set(["EBUSY", "EPERM", "EACCES"]);
const defaultMaxRenameAttempts = 6;
const defaultRenameRetryDelayMs = 25;
const defaultMaxRemoveAttempts = 10;
const defaultRemoveRetryDelayMs = 50;

function isTransientFileError(err: unknown): boolean {
  return transientFileErrorCodes.has((err as NodeJS.ErrnoException).code ?? "");
}

function resolveMemoryIndexFileOptions(
  options: MemoryIndexFileOptions = {},
): ResolvedMemoryIndexFileOptions {
  return {
    fileOps: options.fileOps ?? defaultFileOps,
    maxRenameAttempts: Math.max(1, options.maxRenameAttempts ?? defaultMaxRenameAttempts),
    renameRetryDelayMs: options.renameRetryDelayMs ?? defaultRenameRetryDelayMs,
    maxRemoveAttempts: Math.max(1, options.maxRemoveAttempts ?? defaultMaxRemoveAttempts),
    removeRetryDelayMs: options.removeRetryDelayMs ?? defaultRemoveRetryDelayMs,
  };
}

async function renameWithRetry(
  source: string,
  target: string,
  options: ResolvedMemoryIndexFileOptions,
  optional = false,
): Promise<void> {
  for (let attempt = 1; attempt <= options.maxRenameAttempts; attempt++) {
    try {
      await options.fileOps.rename(source, target);
      return;
    } catch (err) {
      if (optional && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      if (!isTransientFileError(err) || attempt === options.maxRenameAttempts) {
        throw err;
      }
      await options.fileOps.wait(options.renameRetryDelayMs * attempt);
    }
  }
  throw new Error("rename retry loop exited unexpectedly");
}

export async function moveMemoryIndexFiles(
  sourceBase: string,
  targetBase: string,
  options: MemoryIndexFileOptions = {},
): Promise<void> {
  const resolvedOptions = resolveMemoryIndexFileOptions(options);
  const suffixes = ["", "-wal", "-shm"];
  for (const suffix of suffixes) {
    const source = `${sourceBase}${suffix}`;
    const target = `${targetBase}${suffix}`;
    await renameWithRetry(source, target, resolvedOptions, suffix !== "");
  }
}

async function rmWithRetry(path: string, options: ResolvedMemoryIndexFileOptions): Promise<void> {
  for (let attempt = 1; attempt <= options.maxRemoveAttempts; attempt++) {
    try {
      await options.fileOps.rm(path, { force: true });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      if (!isTransientFileError(err) || attempt === options.maxRemoveAttempts) {
        throw err;
      }
      await options.fileOps.wait(options.removeRetryDelayMs * attempt);
    }
  }
  throw new Error("rm retry loop exited unexpectedly");
}

export async function removeMemoryIndexFiles(
  basePath: string,
  options: MemoryIndexFileOptions = {},
): Promise<void> {
  const resolvedOptions = resolveMemoryIndexFileOptions(options);
  const suffixes = ["", "-wal", "-shm"];
  for (const suffix of suffixes) {
    await rmWithRetry(`${basePath}${suffix}`, resolvedOptions);
  }
}

async function removeMemoryIndexSidecars(
  basePath: string,
  options: ResolvedMemoryIndexFileOptions,
): Promise<void> {
  await rmWithRetry(`${basePath}-wal`, options);
  await rmWithRetry(`${basePath}-shm`, options);
}

async function moveMemoryIndexSidecars(
  sourceBase: string,
  targetBase: string,
  options: ResolvedMemoryIndexFileOptions,
): Promise<void> {
  const suffixes = ["-wal", "-shm"];
  for (const suffix of suffixes) {
    await renameWithRetry(`${sourceBase}${suffix}`, `${targetBase}${suffix}`, options, true);
  }
}

async function moveMemoryIndexSidecarsWithRollback(
  sourceBase: string,
  targetBase: string,
  options: ResolvedMemoryIndexFileOptions,
): Promise<void> {
  try {
    await moveMemoryIndexSidecars(sourceBase, targetBase, options);
  } catch (err) {
    try {
      await moveMemoryIndexSidecars(targetBase, sourceBase, options);
    } catch (rollbackErr) {
      const aggregateErr = new AggregateError(
        [err, rollbackErr],
        "memory index sidecar backup failed and rollback failed",
        { cause: rollbackErr },
      );
      throw aggregateErr;
    }
    throw err;
  }
}

async function swapMemoryIndexFiles(
  targetPath: string,
  tempPath: string,
  options: MemoryIndexFileOptions = {},
): Promise<void> {
  // On POSIX (Linux/macOS), rename(2) atomically overwrites the target,
  // so there is no absent-window between removing the old index and
  // publishing the new one. On Windows, rename fails when the target
  // exists, so the three-step backup protocol is retained.
  const resolvedOptions = resolveMemoryIndexFileOptions(options);
  const backupPath = `${targetPath}.backup-${randomUUID()}`;
  // The old and temp DBs are checkpointed and closed before swap. Hide target
  // sidecars before publishing the new main DB, but keep them rollbackable
  // until the main-file publish succeeds.
  await moveMemoryIndexSidecarsWithRollback(targetPath, backupPath, resolvedOptions);
  try {
    await renameWithRetry(tempPath, targetPath, resolvedOptions);
  } catch (err) {
    if (
      (err as NodeJS.ErrnoException).code === "EPERM" ||
      (err as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      // Windows: target exists, use three-step backup protocol with rollback.
      try {
        await renameWithRetry(targetPath, backupPath, resolvedOptions);
      } catch (backupErr) {
        await moveMemoryIndexSidecars(backupPath, targetPath, resolvedOptions);
        throw backupErr;
      }
      try {
        await renameWithRetry(tempPath, targetPath, resolvedOptions);
      } catch (moveErr) {
        await moveMemoryIndexFiles(backupPath, targetPath, options);
        throw moveErr;
      }
    } else {
      await moveMemoryIndexSidecars(backupPath, targetPath, resolvedOptions);
      throw err;
    }
  }
  await removeMemoryIndexFiles(backupPath, options);
  // Closed temp databases should not need sidecars after checkpoint; remove
  // leftovers at the temp path without touching the published target pair.
  await removeMemoryIndexSidecars(tempPath, resolvedOptions);
}

export async function runMemoryAtomicReindex<T>(params: {
  targetPath: string;
  tempPath: string;
  build: () => Promise<T>;
  beforeTempCleanup?: () => Promise<void> | void;
  fileOptions?: MemoryIndexFileOptions;
}): Promise<T> {
  try {
    const result = await params.build();
    await swapMemoryIndexFiles(params.targetPath, params.tempPath, params.fileOptions);
    return result;
  } catch (err) {
    try {
      await params.beforeTempCleanup?.();
      await removeMemoryIndexFiles(params.tempPath, params.fileOptions);
    } catch (cleanupErr) {
      const aggregateErr = new AggregateError(
        [err, cleanupErr],
        "memory atomic reindex failed and temp cleanup failed",
        { cause: cleanupErr },
      );
      throw aggregateErr;
    }
    throw err;
  }
}

// A hard kill (SIGKILL, or a SIGTERM that does not unwind) during
// `runSafeReindex()` bypasses both the success swap and the catch-cleanup, so
// the `${dbPath}.tmp-<uuid>` triplet built for the atomic swap is orphaned on
// disk and never reclaimed (each is a full copy of the index). These orphans
// are crash-safe to delete by construction: either the swap already completed
// (the live base DB is authoritative) or it never happened (the temp is a
// partial build). The only hazard is a *concurrent* reindex's still-live temp,
// which we avoid with an age grace window.
const defaultReindexTempGraceMs = 60_000;

type SweepOrphanedReindexTempFilesOptions = {
  // Only remove temp triplets whose main file has not been modified within this
  // window. Guards against deleting a temp still owned by an in-flight reindex.
  graceMs?: number;
  fileOptions?: MemoryIndexFileOptions;
  io?: {
    readdir?: (dir: string) => Promise<string[]>;
    stat?: (filePath: string) => Promise<{ mtimeMs: number }>;
    now?: () => number;
  };
};

function isReindexTempSibling(basename: string, prefix: string): boolean {
  // Match `<db>.tmp-<uuid>` main files only; the `-wal`/`-shm` sidecars are
  // removed together with their main file via removeMemoryIndexFiles().
  return basename.startsWith(prefix) && !basename.endsWith("-wal") && !basename.endsWith("-shm");
}

/**
 * Sweep aged orphaned `${dbPath}.tmp-<uuid>` reindex triplets left by a hard
 * kill during a prior atomic reindex. Intended to run once at memory store init,
 * before the live DB is opened/cached. Best-effort: missing directories and
 * per-file removal errors are swallowed so startup never fails on cleanup.
 *
 * @returns the base paths of the temp triplets that were removed.
 */
export async function sweepOrphanedReindexTempFiles(
  dbPath: string,
  options: SweepOrphanedReindexTempFilesOptions = {},
): Promise<string[]> {
  const graceMs = Math.max(0, options.graceMs ?? defaultReindexTempGraceMs);
  const readdir = options.io?.readdir ?? fs.readdir;
  const stat = options.io?.stat ?? ((filePath: string) => fs.stat(filePath));
  const now = options.io?.now ?? Date.now;

  const dir = path.dirname(dbPath);
  const prefix = `${path.basename(dbPath)}.tmp-`;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Store directory does not exist yet (fresh install) or is unreadable.
    return [];
  }

  const cutoff = now() - graceMs;
  const removed: string[] = [];
  for (const entry of entries) {
    if (!isReindexTempSibling(entry, prefix)) {
      continue;
    }
    const tempBasePath = path.join(dir, entry);
    try {
      const info = await stat(tempBasePath);
      if (info.mtimeMs > cutoff) {
        // Recently touched: may belong to a concurrent in-flight reindex.
        continue;
      }
      await removeMemoryIndexFiles(tempBasePath, options.fileOptions);
      removed.push(tempBasePath);
    } catch {
      // A racing reindex may swap/remove this file between readdir and stat,
      // or removal may transiently fail; skip and let a later run retry.
    }
  }
  return removed;
}
