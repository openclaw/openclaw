import { AsyncLocalStorage } from "node:async_hooks";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type {
  PluginStateCompareIntent,
  PluginStateKeyedStore,
  PluginStateObservation,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  getFileLockProcessStartTime,
  isPidDefinitelyDead,
} from "openclaw/plugin-sdk/process-runtime";
import {
  SHORT_TERM_LOCK_NAMESPACE,
  memoryCoreStateReference,
  memoryCoreWorkspaceStateKey,
} from "./dreaming-state.js";
import type { ShortTermLockEntry } from "./short-term-promotion-types.js";

const SHORT_TERM_LOCK_STALE_MS = 60_000;
const inProcessMemoryWorkspaceLocks = new KeyedAsyncQueue();

type MemoryWorkspaceLease = { key: string; active: boolean };
type MemoryWorkspaceLockScope = {
  lease: MemoryWorkspaceLease;
  active: boolean;
  childTail: Promise<void>;
  parent: MemoryWorkspaceLockScope | undefined;
};
const memoryWorkspaceLockScopes = new AsyncLocalStorage<MemoryWorkspaceLockScope>();

function findActiveWorkspaceLockScope(key: string): MemoryWorkspaceLockScope | undefined {
  let scope = memoryWorkspaceLockScopes.getStore();
  while (scope) {
    if (!scope.active || !scope.lease.active) {
      return undefined;
    }
    if (scope.lease.key === key) {
      return scope;
    }
    scope = scope.parent;
  }
  return undefined;
}

async function runWorkspaceLockScope<T>(
  lease: MemoryWorkspaceLease,
  task: () => Promise<T>,
): Promise<T> {
  const scope: MemoryWorkspaceLockScope = {
    lease,
    active: true,
    childTail: Promise.resolve(),
    parent: memoryWorkspaceLockScopes.getStore(),
  };
  try {
    return await memoryWorkspaceLockScopes.run(scope, task);
  } finally {
    // Closed async contexts must acquire a new lease. Already accepted children
    // finish before the owner admits the next workspace writer.
    scope.active = false;
    await scope.childTail;
  }
}

export function resolveLockPath(workspaceDir: string): string {
  return memoryCoreStateReference(SHORT_TERM_LOCK_NAMESPACE, workspaceDir);
}

function parseLockOwnerPid(raw: string): number | null {
  const match = raw.trim().match(/^(\d+):/);
  const pid = Number.parseInt(match?.[1] ?? "", 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function isShortTermLockStealable(existing: ShortTermLockEntry, nowMs: number): boolean {
  if (nowMs - existing.acquiredAt <= SHORT_TERM_LOCK_STALE_MS) {
    return false;
  }
  const ownerPid = parseLockOwnerPid(existing.owner);
  if (ownerPid === null) {
    return true;
  }
  if (ownerPid === process.pid) {
    // Runtime coordination is process-local; these are legacy diagnostic rows.
    return true;
  }
  if (isPidDefinitelyDead(ownerPid)) {
    return true;
  }
  // Shipped rows lack start identity. Keep a live foreign PID authoritative.
  if (existing.ownerStartTime === undefined) {
    return false;
  }
  const currentStartTime = getFileLockProcessStartTime(ownerPid);
  return currentStartTime !== null && currentStartTime !== existing.ownerStartTime;
}

export async function deleteShortTermLockEntryIfCurrent(
  lockStore: PluginStateKeyedStore<ShortTermLockEntry>,
  lockKey: string,
  expected: ShortTermLockEntry,
  initialObservation?: PluginStateObservation<ShortTermLockEntry>,
): Promise<boolean> {
  if (!lockStore.observe || !lockStore.compareAndApply) {
    throw new Error("memory-core short-term lock store requires atomic comparisons");
  }
  const { owner, acquiredAt } = expected;
  const decideDeletion = (
    current: ShortTermLockEntry | undefined,
  ): PluginStateCompareIntent<ShortTermLockEntry> => ({
    operation: "delete",
    action:
      current !== undefined && current.owner === owner && current.acquiredAt === acquiredAt
        ? "delete"
        : "keep",
  });
  let observation = initialObservation ?? (await lockStore.observe(lockKey));
  while (true) {
    const result = await lockStore.compareAndApply(
      lockKey,
      observation.comparison,
      decideDeletion(observation.value),
    );
    if (result.status !== "conflict") {
      return result.status === "applied";
    }
    observation = result.current;
  }
}

/** Captured input preparation shares local ordering without claiming a durable write lease. */
export async function withMemoryWorkspacePreparation<T>(
  workspaceDir: string,
  prepare: () => Promise<T>,
): Promise<T> {
  const key = memoryCoreWorkspaceStateKey(workspaceDir);
  if (findActiveWorkspaceLockScope(key)) {
    return await withMemoryWorkspaceLock(workspaceDir, prepare);
  }
  // Keep existing FIFO and pending Worker input bounds; never mint a write scope.
  return await inProcessMemoryWorkspaceLocks.enqueue(key, prepare);
}

export async function withMemoryWorkspaceLock<T>(
  workspaceDir: string,
  task: () => Promise<T>,
): Promise<T> {
  const lockKey = memoryCoreWorkspaceStateKey(workspaceDir);
  const scope = findActiveWorkspaceLockScope(lockKey);
  if (scope) {
    // Each scope queues its children separately: nested calls can reenter,
    // while Promise.all siblings cannot race read-modify-write operations.
    const child = scope.childTail.then(() => runWorkspaceLockScope(scope.lease, task));
    scope.childTail = child.then(
      () => undefined,
      () => undefined,
    );
    return await child;
  }
  return await inProcessMemoryWorkspaceLocks.enqueue(lockKey, async () => {
    const lease = { key: lockKey, active: true };
    try {
      return await runWorkspaceLockScope(lease, task);
    } finally {
      lease.active = false;
    }
  });
}
