/**
 * Cross-process serialization for deterministic sandbox scope names.
 *
 * Runtime creation and lifecycle cleanup share deterministic container/workspace
 * names, so destructive cleanup must not overlap replacement creation.
 */
import path from "node:path";
import { acquireSessionWriteLock } from "../session-write-lock.js";
import { SANDBOX_STATE_DIR } from "./constants.js";
import { hashTextSha256 } from "./hash.js";

const SANDBOX_SCOPE_LOCKS_KEY = Symbol.for("openclaw.sandboxScopeLocks");
const SANDBOX_SCOPE_LOCK_MAX_HOLD_MS = 30 * 60 * 1000;
const SANDBOX_SCOPE_LOCK_STALE_MS = 60 * 60 * 1000;

function resolveSandboxScopeLockFile(scopeKey: string): string {
  return path.join(SANDBOX_STATE_DIR, "locks", "scope", `scope-${hashTextSha256(scopeKey)}.jsonl`);
}

function scopeLocks(): Map<string, Promise<void>> {
  const globalStore = globalThis as typeof globalThis & {
    [SANDBOX_SCOPE_LOCKS_KEY]?: Map<string, Promise<void>>;
  };
  globalStore[SANDBOX_SCOPE_LOCKS_KEY] ??= new Map();
  return globalStore[SANDBOX_SCOPE_LOCKS_KEY];
}

function toScopeLockError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function withSandboxScopeLock<T>(scopeKey: string, run: () => Promise<T>): Promise<T> {
  const key = scopeKey.trim() || "main";
  const locks = scopeLocks();
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  locks.set(key, tail);
  await previous.catch(() => undefined);
  let lock: Awaited<ReturnType<typeof acquireSessionWriteLock>> | undefined;
  let result: T | undefined;
  let primaryFailed = false;
  let primaryError: unknown;
  try {
    lock = await acquireSessionWriteLock({
      sessionFile: resolveSandboxScopeLockFile(key),
      timeoutMs: Number.POSITIVE_INFINITY,
      staleMs: SANDBOX_SCOPE_LOCK_STALE_MS,
      maxHoldMs: SANDBOX_SCOPE_LOCK_MAX_HOLD_MS,
      allowReentrant: true,
    });
    result = await run();
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
  }
  let releaseError: unknown;
  try {
    await lock?.release();
  } catch (error: unknown) {
    releaseError = error;
  }
  release();
  if (locks.get(key) === tail) {
    locks.delete(key);
  }
  if (primaryFailed) {
    throw toScopeLockError(primaryError);
  }
  if (releaseError) {
    throw toScopeLockError(releaseError);
  }
  return result as T;
}

export async function withSandboxScopeLocks<T>(
  scopeKeys: readonly string[],
  run: () => Promise<T>,
): Promise<T> {
  const [scopeKey, ...remaining] = Array.from(
    new Set(scopeKeys.map((key) => key.trim()).filter(Boolean)),
  ).toSorted();
  if (!scopeKey) {
    return await run();
  }
  return await withSandboxScopeLock(scopeKey, () => withSandboxScopeLocks(remaining, run));
}
