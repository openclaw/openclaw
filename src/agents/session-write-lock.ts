import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isPidAlive } from "../shared/pid-alive.js";

type LockFilePayload = {
  pid: number;
  createdAt: string;
};

type HeldLock = {
  count: number;
  handle: fs.FileHandle;
  lockPath: string;
};

const CLEANUP_SIGNALS = ["SIGINT", "SIGTERM", "SIGQUIT", "SIGABRT"] as const;
type CleanupSignal = (typeof CLEANUP_SIGNALS)[number];
const CLEANUP_STATE_KEY = Symbol.for("bot.sessionWriteLockCleanupState");
const HELD_LOCKS_KEY = Symbol.for("bot.sessionWriteLockHeldLocks");

type CleanupState = {
  registered: boolean;
  cleanupHandlers: Map<CleanupSignal, () => void>;
};

function resolveHeldLocks(): Map<string, HeldLock> {
  const proc = process as NodeJS.Process & {
    [HELD_LOCKS_KEY]?: Map<string, HeldLock>;
  };
  if (!proc[HELD_LOCKS_KEY]) {
    proc[HELD_LOCKS_KEY] = new Map<string, HeldLock>();
  }
  return proc[HELD_LOCKS_KEY];
}

const HELD_LOCKS = resolveHeldLocks();

function resolveCleanupState(): CleanupState {
  const proc = process as NodeJS.Process & {
    [CLEANUP_STATE_KEY]?: CleanupState;
  };
  if (!proc[CLEANUP_STATE_KEY]) {
    proc[CLEANUP_STATE_KEY] = {
      registered: false,
      cleanupHandlers: new Map<CleanupSignal, () => void>(),
    };
  }
  return proc[CLEANUP_STATE_KEY];
}

/**
 * Synchronously release all held locks.
 * Used during process exit when async operations aren't reliable.
 */
function releaseAllLocksSync(): void {
  for (const [sessionFile, held] of HELD_LOCKS) {
    try {
      if (typeof held.handle.close === "function") {
        void held.handle.close().catch(() => {});
      }
    } catch {
      // Ignore errors during cleanup - best effort
    }
    try {
      fsSync.rmSync(held.lockPath, { force: true });
    } catch {
      // Ignore errors during cleanup - best effort
    }
    HELD_LOCKS.delete(sessionFile);
  }
}

function handleTerminationSignal(signal: CleanupSignal): void {
  releaseAllLocksSync();
  const cleanupState = resolveCleanupState();
  const shouldReraise = process.listenerCount(signal) === 1;
  if (shouldReraise) {
    const handler = cleanupState.cleanupHandlers.get(signal);
    if (handler) {
      process.off(signal, handler);
      cleanupState.cleanupHandlers.delete(signal);
    }
    try {
      process.kill(process.pid, signal);
    } catch {
      // Ignore errors during shutdown
    }
  }
}

function registerCleanupHandlers(): void {
  const cleanupState = resolveCleanupState();
  if (!cleanupState.registered) {
    cleanupState.registered = true;
    // Cleanup on normal exit and process.exit() calls
    process.on("exit", () => {
      releaseAllLocksSync();
    });
  }

  // Handle termination signals
  for (const signal of CLEANUP_SIGNALS) {
    if (cleanupState.cleanupHandlers.has(signal)) {
      continue;
    }
    try {
      const handler = () => handleTerminationSignal(signal);
      cleanupState.cleanupHandlers.set(signal, handler);
      process.on(signal, handler);
    } catch {
      // Ignore unsupported signals on this platform.
    }
  }
}

async function readLockPayload(lockPath: string): Promise<LockFilePayload | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockFilePayload>;
    if (typeof parsed.pid !== "number") {
      return null;
    }
    if (typeof parsed.createdAt !== "string") {
      return null;
    }
    return { pid: parsed.pid, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

export async function acquireSessionWriteLock(params: {
  sessionFile: string;
  timeoutMs?: number;
  staleMs?: number;
}): Promise<{
  release: () => Promise<void>;
}> {
  registerCleanupHandlers();
  const timeoutMs = params.timeoutMs ?? 10_000;
  const staleMs = params.staleMs ?? 30 * 60 * 1000;
  const sessionFile = path.resolve(params.sessionFile);
  const sessionDir = path.dirname(sessionFile);
  await fs.mkdir(sessionDir, { recursive: true });
  let normalizedDir = sessionDir;
  try {
    normalizedDir = await fs.realpath(sessionDir);
  } catch {
    // Fall back to the resolved path if realpath fails (permissions, transient FS).
  }
  const normalizedSessionFile = path.join(normalizedDir, path.basename(sessionFile));
  const lockPath = `${normalizedSessionFile}.lock`;
  const release = async () => {
    const current = HELD_LOCKS.get(normalizedSessionFile);
    if (!current) {
      return;
    }
    current.count -= 1;
    if (current.count > 0) {
      return;
    }
    HELD_LOCKS.delete(normalizedSessionFile);
    await current.handle.close();
    await fs.rm(current.lockPath, { force: true });
  };

  const held = HELD_LOCKS.get(normalizedSessionFile);
  if (held) {
    held.count += 1;
    return {
      release,
    };
  }

  const startedAt = Date.now();
  let attempt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    attempt += 1;
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2),
        "utf8",
      );
      HELD_LOCKS.set(normalizedSessionFile, { count: 1, handle, lockPath });
      return {
        release,
      };
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code !== "EEXIST") {
        throw err;
      }
      const payload = await readLockPayload(lockPath);
      const createdAt = payload?.createdAt ? Date.parse(payload.createdAt) : NaN;
      const stale = !Number.isFinite(createdAt) || Date.now() - createdAt > staleMs;
      const alive = payload?.pid ? isPidAlive(payload.pid) : false;
      if (stale || !alive) {
        await fs.rm(lockPath, { force: true });
        continue;
      }

      const delay = Math.min(1000, 50 * attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  const payload = await readLockPayload(lockPath);
  const owner = payload?.pid ? `pid=${payload.pid}` : "unknown";
  throw new Error(`session file locked (timeout ${timeoutMs}ms): ${owner} ${lockPath}`);
}

export type SessionLockInspection = {
  lockPath: string;
  pid: number | null;
  pidAlive: boolean;
  ageMs: number | null;
  stale: boolean;
  staleReasons: string[];
  removed: boolean;
};

export function resolveSessionLockMaxHoldFromTimeout(timeoutMs: number): number {
  return Math.max(timeoutMs * 2, 60_000);
}

export async function cleanStaleLockFiles(params: {
  sessionsDir: string;
  staleMs: number;
  nowMs?: number;
  removeStale?: boolean;
}): Promise<{ locks: SessionLockInspection[]; cleaned: SessionLockInspection[] }> {
  const nowMs = params.nowMs ?? Date.now();
  const locks: SessionLockInspection[] = [];
  const cleaned: SessionLockInspection[] = [];

  let entries: string[];
  try {
    entries = await fs.readdir(params.sessionsDir);
  } catch {
    return { locks, cleaned };
  }

  const lockFiles = entries.filter((entry) => entry.endsWith(".lock"));
  for (const lockFile of lockFiles) {
    const lockPath = path.join(params.sessionsDir, lockFile);
    const payload = await readLockPayload(lockPath);
    const pid = payload?.pid ?? null;
    const pidAlive = pid !== null ? isPidAlive(pid) : false;
    const createdAt = payload?.createdAt ? Date.parse(payload.createdAt) : NaN;
    const ageMs = Number.isFinite(createdAt) ? nowMs - createdAt : null;

    const staleReasons: string[] = [];
    if (pid !== null && !pidAlive) {
      staleReasons.push("pid-dead");
    }
    if (ageMs !== null && ageMs > params.staleMs) {
      staleReasons.push("age-exceeded");
    }
    if (pid === null) {
      staleReasons.push("no-pid");
    }
    const stale = staleReasons.length > 0;

    let removed = false;
    if (stale && params.removeStale) {
      try {
        await fs.rm(lockPath, { force: true });
        removed = true;
      } catch {
        // Best effort.
      }
    }

    const inspection: SessionLockInspection = {
      lockPath,
      pid,
      pidAlive,
      ageMs,
      stale,
      staleReasons,
      removed,
    };
    locks.push(inspection);
    if (removed) {
      cleaned.push(inspection);
    }
  }

  return { locks, cleaned };
}

export const __testing = {
  cleanupSignals: [...CLEANUP_SIGNALS],
  handleTerminationSignal,
  releaseAllLocksSync,
};
