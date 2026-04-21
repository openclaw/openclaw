import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type FileLockOptions = {
  retries: {
    retries: number;
    factor: number;
    minTimeout: number;
    maxTimeout: number;
    randomize?: boolean;
  };
  stale: number;
};

type LockFilePayload = {
  pid: number;
  createdAt: string;
};

type HeldLock = {
  count: number;
  handle: fs.FileHandle;
  lockPath: string;
};

const HELD_LOCKS = new Map<string, HeldLock>();
let cleanupRegistered = false;

function releaseAllLocksSync(): void {
  for (const [normalizedFile, held] of HELD_LOCKS) {
    void held.handle.close().catch(() => undefined);
    try {
      fsSync.rmSync(held.lockPath, { force: true });
    } catch {}
    HELD_LOCKS.delete(normalizedFile);
  }
}

function ensureExitCleanupRegistered(): void {
  if (cleanupRegistered) {
    return;
  }
  cleanupRegistered = true;
  process.on("exit", releaseAllLocksSync);
}

function computeDelayMs(retries: FileLockOptions["retries"], attempt: number): number {
  const base = Math.min(
    retries.maxTimeout,
    Math.max(retries.minTimeout, retries.minTimeout * retries.factor ** attempt),
  );
  const jitter = retries.randomize ? 1 + Math.random() : 1;
  return Math.min(retries.maxTimeout, Math.round(base * jitter));
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

async function readLockPayload(lockPath: string): Promise<LockFilePayload | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockFilePayload>;
    if (typeof parsed.pid !== "number" || typeof parsed.createdAt !== "string") {
      return null;
    }
    return { pid: parsed.pid, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

async function resolveNormalizedFilePath(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  await fs.mkdir(dir, { recursive: true });
  try {
    const realDir = await fs.realpath(dir);
    return path.join(realDir, path.basename(resolved));
  } catch {
    return resolved;
  }
}

async function isStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  const payload = await readLockPayload(lockPath);
  if (payload?.pid && !isPidAlive(payload.pid)) {
    return true;
  }
  if (payload?.createdAt) {
    const createdAt = Date.parse(payload.createdAt);
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > staleMs) {
      return true;
    }
  }
  try {
    const stat = await fs.stat(lockPath);
    return Date.now() - stat.mtimeMs > staleMs;
  } catch {
    return true;
  }
}

async function releaseHeldLock(normalizedFile: string): Promise<void> {
  const current = HELD_LOCKS.get(normalizedFile);
  if (!current) {
    return;
  }
  current.count -= 1;
  if (current.count > 0) {
    return;
  }
  HELD_LOCKS.delete(normalizedFile);
  await current.handle.close().catch(() => undefined);
  await fs.rm(current.lockPath, { force: true }).catch(() => undefined);
}

async function acquireFileLock(
  filePath: string,
  options: FileLockOptions,
): Promise<{ release: () => Promise<void> }> {
  ensureExitCleanupRegistered();
  const normalizedFile = await resolveNormalizedFilePath(filePath);
  const lockPath = `${normalizedFile}.lock`;
  const held = HELD_LOCKS.get(normalizedFile);
  if (held) {
    held.count += 1;
    return { release: () => releaseHeldLock(normalizedFile) };
  }

  for (let attempt = 0; attempt <= options.retries.retries; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2),
          "utf8",
        );
      } catch (writeError) {
        await handle.close().catch(() => undefined);
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
        throw writeError;
      }
      HELD_LOCKS.set(normalizedFile, { count: 1, handle, lockPath });
      return { release: () => releaseHeldLock(normalizedFile) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EEXIST") {
        throw error;
      }
      if (await isStaleLock(lockPath, options.stale)) {
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (attempt >= options.retries.retries) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, computeDelayMs(options.retries, attempt)));
    }
  }

  throw Object.assign(new Error(`file lock timeout for ${normalizedFile}`), {
    code: "file_lock_timeout",
    lockPath,
  });
}

export async function withFileLock<T>(
  filePath: string,
  options: FileLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await acquireFileLock(filePath, options);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
