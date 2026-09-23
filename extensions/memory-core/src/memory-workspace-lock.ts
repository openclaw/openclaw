import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type {
  PluginStateCompareIntent,
  PluginStateCompareResult,
  PluginStateKeyedStore,
  PluginStateObservation,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  getFileLockProcessStartTime,
  isPidDefinitelyDead,
} from "openclaw/plugin-sdk/process-runtime";
import { sleep } from "openclaw/plugin-sdk/runtime-env";
import {
  SHORT_TERM_LOCK_MAX_ENTRIES,
  SHORT_TERM_LOCK_NAMESPACE,
  memoryCoreStateReference,
  memoryCoreWorkspaceStateKey,
  openMemoryCoreStateStore,
} from "./dreaming-state.js";
import type { ShortTermLockEntry } from "./short-term-promotion-types.js";

const MEMORY_WORKSPACE_LOCK_WAIT_TIMEOUT_MS = 10_000;
const SHORT_TERM_LOCK_STALE_MS = 60_000;
const MEMORY_WORKSPACE_LOCK_RETRY_DELAY_MS = 40;
const inProcessMemoryWorkspaceLocks = new KeyedAsyncQueue();
const activeMemoryWorkspaceLockOwners = new Map<string, string>();
type MemoryWorkspaceLockReceipt = {
  key: string;
  entry: ShortTermLockEntry;
  observation: PluginStateObservation<ShortTermLockEntry>;
};
const pendingMemoryWorkspaceLockReleases = new Map<string, MemoryWorkspaceLockReceipt>();

function retainMemoryWorkspaceLockRelease(receipt: MemoryWorkspaceLockReceipt): void {
  const now = Date.now();
  for (const [owner, pending] of pendingMemoryWorkspaceLockReleases) {
    if (now - pending.entry.acquiredAt > SHORT_TERM_LOCK_STALE_MS) {
      pendingMemoryWorkspaceLockReleases.delete(owner);
    }
  }
  if (now - receipt.entry.acquiredAt > SHORT_TERM_LOCK_STALE_MS) {
    return;
  }
  pendingMemoryWorkspaceLockReleases.set(receipt.entry.owner, receipt);
  if (pendingMemoryWorkspaceLockReleases.size > SHORT_TERM_LOCK_MAX_ENTRIES) {
    const oldest = pendingMemoryWorkspaceLockReleases.keys().next().value;
    if (oldest !== undefined) {
      pendingMemoryWorkspaceLockReleases.delete(oldest);
    }
  }
}

type MemoryWorkspaceLockAcquisitionFailure =
  | { kind: "held"; holder: { owner: string; epoch: number } }
  | { kind: "store-unavailable"; reason: "storage-error" | "holder-unobserved" };

class MemoryWorkspaceLockAcquisitionError extends Error {
  readonly code: "MEMORY_WORKSPACE_LOCK_HELD" | "MEMORY_WORKSPACE_LOCK_STORE_UNAVAILABLE";

  constructor(
    lockRef: string,
    readonly outcome: MemoryWorkspaceLockAcquisitionFailure,
    cause?: unknown,
  ) {
    super(
      outcome.kind === "held"
        ? `Timed out waiting for memory workspace lock at ${lockRef} (held by ${outcome.holder.owner})`
        : `Memory workspace lock store unavailable at ${lockRef}: ${outcome.reason}`,
      { cause },
    );
    this.code =
      outcome.kind === "held"
        ? "MEMORY_WORKSPACE_LOCK_HELD"
        : "MEMORY_WORKSPACE_LOCK_STORE_UNAVAILABLE";
  }
}

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
    // finish before the owner releases the cross-process lock.
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

export function isShortTermLockStealable(
  lockKey: string,
  existing: ShortTermLockEntry,
  nowMs: number,
): boolean {
  if (nowMs - existing.acquiredAt <= SHORT_TERM_LOCK_STALE_MS) {
    return false;
  }
  const ownerPid = parseLockOwnerPid(existing.owner);
  if (ownerPid === null) {
    return true;
  }
  if (ownerPid === process.pid) {
    // The current process can own this row only through the tracked local lease.
    // A same-PID row without that lease survived a prior process or failed cleanup.
    return activeMemoryWorkspaceLockOwners.get(lockKey) !== existing.owner;
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
  const lockRef = resolveLockPath(workspaceDir);
  const lockStore = openMemoryCoreStateStore<ShortTermLockEntry>({
    namespace: SHORT_TERM_LOCK_NAMESPACE,
    maxEntries: SHORT_TERM_LOCK_MAX_ENTRIES,
  });
  return await inProcessMemoryWorkspaceLocks.enqueue(lockKey, async () => {
    const receipt = await acquireMemoryWorkspaceLock(lockStore, lockKey, lockRef);
    const lease = { key: lockKey, active: true };
    activeMemoryWorkspaceLockOwners.set(lockKey, receipt.entry.owner);
    try {
      return await runWorkspaceLockScope(lease, task);
    } finally {
      lease.active = false;
      activeMemoryWorkspaceLockOwners.delete(lockKey);
      try {
        await deleteShortTermLockEntryIfCurrent(
          lockStore,
          lockKey,
          receipt.entry,
          receipt.observation,
        );
      } catch {
        retainMemoryWorkspaceLockRelease(receipt);
      }
    }
  });
}

async function acquireMemoryWorkspaceLock(
  lockStore: PluginStateKeyedStore<ShortTermLockEntry>,
  lockKey: string,
  lockRef: string,
): Promise<MemoryWorkspaceLockReceipt> {
  const startedAt = Date.now();
  while (true) {
    let outcome: MemoryWorkspaceLockAcquisitionFailure;
    try {
      if (!lockStore.observe || !lockStore.compareAndApply) {
        throw new Error("memory-core short-term lock store requires atomic comparisons");
      }
      const observation = await lockStore.observe(lockKey);
      let existing = observation.value;
      if (existing === undefined) {
        const ownerStartTime = getFileLockProcessStartTime(process.pid);
        const lockEntry: ShortTermLockEntry = {
          owner: `${process.pid}:${randomUUID()}`,
          acquiredAt: Date.now(),
          ...(ownerStartTime === null ? {} : { ownerStartTime }),
        };
        const receipt = { key: lockKey, entry: lockEntry, observation };
        let acquired: PluginStateCompareResult<ShortTermLockEntry>;
        try {
          acquired = await lockStore.compareAndApply(lockKey, observation.comparison, {
            operation: "update",
            action: "set",
            value: lockEntry,
          });
        } catch (error) {
          // Worker rejection joins native settlement; the task has not started.
          retainMemoryWorkspaceLockRelease(receipt);
          throw error;
        }
        if (acquired.status === "applied") {
          return receipt;
        }
        if (acquired.status === "conflict") {
          existing = acquired.current.value;
        }
      } else {
        const pending = pendingMemoryWorkspaceLockReleases.get(existing.owner);
        if (pending && Date.now() - pending.entry.acquiredAt > SHORT_TERM_LOCK_STALE_MS) {
          pendingMemoryWorkspaceLockReleases.delete(existing.owner);
        } else if (pending?.key === lockKey && pending.entry.acquiredAt === existing.acquiredAt) {
          // The acquisition token fences cleanup to its original physical store.
          await deleteShortTermLockEntryIfCurrent(
            lockStore,
            lockKey,
            pending.entry,
            pending.observation,
          );
          pendingMemoryWorkspaceLockReleases.delete(existing.owner);
          continue;
        }
        if (
          isShortTermLockStealable(lockKey, existing, Date.now()) &&
          (await deleteShortTermLockEntryIfCurrent(lockStore, lockKey, existing, observation))
        ) {
          continue;
        }
      }
      outcome = existing
        ? { kind: "held", holder: { owner: existing.owner, epoch: existing.acquiredAt } }
        : { kind: "store-unavailable", reason: "holder-unobserved" };
    } catch (cause) {
      throw new MemoryWorkspaceLockAcquisitionError(
        lockRef,
        { kind: "store-unavailable", reason: "storage-error" },
        cause,
      );
    }
    if (Date.now() - startedAt >= MEMORY_WORKSPACE_LOCK_WAIT_TIMEOUT_MS) {
      throw new MemoryWorkspaceLockAcquisitionError(lockRef, outcome);
    }
    await sleep(MEMORY_WORKSPACE_LOCK_RETRY_DELAY_MS);
  }
}
