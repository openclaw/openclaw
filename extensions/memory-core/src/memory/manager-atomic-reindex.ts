import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

type MemoryIndexFileOps = {
  rename: typeof fs.rename;
  rm: typeof fs.rm;
  wait: (ms: number) => Promise<void>;
};

type MoveMemoryIndexFilesOptions = {
  fileOps?: MemoryIndexFileOps;
  maxRenameAttempts?: number;
  renameRetryDelayMs?: number;
};

const defaultFileOps: MemoryIndexFileOps = {
  rename: fs.rename,
  rm: fs.rm,
  wait: sleep,
};

const transientFileErrorCodes = new Set(["EBUSY", "EPERM", "EACCES"]);
const defaultMaxRenameAttempts = 6;
const defaultRenameRetryDelayMs = 25;
const defaultMaxRemoveAttempts = 6;
const defaultRemoveRetryDelayMs = 25;

function isTransientFileError(err: unknown): boolean {
  return transientFileErrorCodes.has((err as NodeJS.ErrnoException).code ?? "");
}

async function renameWithRetry(
  source: string,
  target: string,
  options: Required<MoveMemoryIndexFilesOptions>,
): Promise<void> {
  for (let attempt = 1; attempt <= options.maxRenameAttempts; attempt++) {
    try {
      await options.fileOps.rename(source, target);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
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
  options: MoveMemoryIndexFilesOptions = {},
): Promise<void> {
  const resolvedOptions: Required<MoveMemoryIndexFilesOptions> = {
    fileOps: options.fileOps ?? defaultFileOps,
    maxRenameAttempts: Math.max(1, options.maxRenameAttempts ?? defaultMaxRenameAttempts),
    renameRetryDelayMs: options.renameRetryDelayMs ?? defaultRenameRetryDelayMs,
  };
  const suffixes = ["", "-wal", "-shm"];
  for (const suffix of suffixes) {
    const source = `${sourceBase}${suffix}`;
    const target = `${targetBase}${suffix}`;
    await renameWithRetry(source, target, resolvedOptions);
  }
}

async function removeWithRetry(
  filePath: string,
  fileOps: MemoryIndexFileOps,
  maxAttempts: number,
  retryDelayMs: number,
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fileOps.rm(filePath, { force: true });
      return;
    } catch (err) {
      if (!isTransientFileError(err) || attempt === maxAttempts) {
        throw err;
      }
      await fileOps.wait(retryDelayMs * attempt);
    }
  }
}

export async function removeMemoryIndexFiles(
  basePath: string,
  fileOps: MemoryIndexFileOps = defaultFileOps,
): Promise<void> {
  const suffixes = ["", "-wal", "-shm"];
  await Promise.all(
    suffixes.map((suffix) =>
      removeWithRetry(
        `${basePath}${suffix}`,
        fileOps,
        defaultMaxRemoveAttempts,
        defaultRemoveRetryDelayMs,
      ),
    ),
  );
}

async function swapMemoryIndexFiles(targetPath: string, tempPath: string): Promise<void> {
  const backupPath = `${targetPath}.backup-${randomUUID()}`;
  await moveMemoryIndexFiles(targetPath, backupPath);
  try {
    await moveMemoryIndexFiles(tempPath, targetPath);
  } catch (err) {
    await moveMemoryIndexFiles(backupPath, targetPath);
    throw err;
  }
  await removeMemoryIndexFiles(backupPath);
}

export async function runMemoryAtomicReindex<T>(params: {
  targetPath: string;
  tempPath: string;
  build: () => Promise<T>;
}): Promise<T> {
  try {
    const result = await params.build();
    await swapMemoryIndexFiles(params.targetPath, params.tempPath);
    return result;
  } catch (err) {
    await removeMemoryIndexFiles(params.tempPath);
    throw err;
  }
}
