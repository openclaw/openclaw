import type {
  PluginStateCompareResult,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteShortTermLockEntryIfCurrent,
  withMemoryWorkspaceLock,
} from "./memory-workspace-lock.js";
import type { ShortTermLockEntry } from "./short-term-promotion-types.js";

const state = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("./dreaming-state.js", () => ({
  SHORT_TERM_LOCK_MAX_ENTRIES: 4_096,
  SHORT_TERM_LOCK_NAMESPACE: "short-term-locks",
  memoryCoreStateReference: (namespace: string, workspace: string) => `${namespace}/${workspace}`,
  memoryCoreWorkspaceStateKey: (workspace: string) => workspace,
  openMemoryCoreStateStore: state.open,
}));
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  getFileLockProcessStartTime: () => 123,
  isPidDefinitelyDead: () => false,
}));
vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  sleep: async () => {
    throw new Error("Unexpected lock contention");
  },
}));

function createLockStore() {
  const rows = new Map<string, ShortTermLockEntry>();
  const observation = (key: string) => ({
    value: structuredClone(rows.get(key)),
    comparison: JSON.stringify(rows.get(key)) ?? "missing",
  });
  const store = {
    observe: vi.fn(async (key: string) => observation(key)),
    compareAndApply: vi.fn<
      NonNullable<PluginStateKeyedStore<ShortTermLockEntry>["compareAndApply"]>
    >(async (key, comparison, intent): Promise<PluginStateCompareResult<ShortTermLockEntry>> => {
      const current = observation(key);
      if (comparison !== current.comparison) {
        return { status: "conflict", current };
      }
      if (intent.action === "keep") {
        return { status: "unchanged" };
      }
      if (intent.action === "delete") {
        return { status: rows.delete(key) ? "applied" : "unchanged" };
      }
      rows.set(key, structuredClone(intent.value));
      return { status: "applied" };
    }),
    async register(key: string, value: ShortTermLockEntry) {
      rows.set(key, structuredClone(value));
    },
    async registerIfAbsent(key: string, value: ShortTermLockEntry) {
      if (rows.has(key)) {
        return false;
      }
      rows.set(key, structuredClone(value));
      return true;
    },
    async lookup(key: string) {
      return structuredClone(rows.get(key));
    },
    async consume(key: string) {
      const value = rows.get(key);
      rows.delete(key);
      return value;
    },
    async delete(key: string) {
      return rows.delete(key);
    },
    async entries() {
      return [...rows].map(([key, value]) => ({ key, value, createdAt: value.acquiredAt }));
    },
    async clear() {
      rows.clear();
    },
  } satisfies PluginStateKeyedStore<ShortTermLockEntry>;
  state.open.mockReturnValue(store);
  return store;
}

afterEach(() => vi.clearAllMocks());

describe("memory workspace lock comparisons", () => {
  const key = "synthetic-workspace";
  const expected: ShortTermLockEntry = { owner: "synthetic-owner", acquiredAt: 1 };

  it("releases a completed workspace lock through data-only storage", async () => {
    const store = createLockStore();
    await expect(
      withMemoryWorkspaceLock(key, async () => {
        expect(await store.lookup(key)).toBeDefined();
        return "completed";
      }),
    ).resolves.toBe("completed");
    expect(await store.lookup(key)).toBeUndefined();
  });

  it("reclaims a stale synthetic lock before running the next task", async () => {
    const store = createLockStore();
    await store.register(key, expected);
    await expect(
      withMemoryWorkspaceLock(key, async () => {
        expect(await store.lookup(key)).not.toEqual(expected);
        return "recovered";
      }),
    ).resolves.toBe("recovered");
    expect(await store.lookup(key)).toBeUndefined();
  });

  it("reports the observed holder when the acquisition bound expires", async () => {
    const store = createLockStore();
    const acquiredAt = Date.now();
    const holder = { owner: `${process.ppid}:active`, acquiredAt };
    await store.register(key, holder);
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(acquiredAt - 10_000)
      .mockReturnValue(acquiredAt);
    const task = vi.fn(async () => "unreachable");
    try {
      await expect(withMemoryWorkspaceLock(key, task)).rejects.toMatchObject({
        code: "MEMORY_WORKSPACE_LOCK_HELD",
        outcome: { kind: "held", holder: { owner: holder.owner, epoch: acquiredAt } },
      });
      expect(task).not.toHaveBeenCalled();
      expect(await store.lookup(key)).toEqual(holder);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    { owner: "replacement-owner", acquiredAt: expected.acquiredAt },
    { owner: expected.owner, acquiredAt: expected.acquiredAt + 1 },
  ])("preserves a replacement lock after a comparison conflict: %j", async (replacement) => {
    const store = createLockStore();
    await store.register(key, expected);
    const compare = store.compareAndApply.getMockImplementation()!;
    store.compareAndApply.mockImplementationOnce(async (...args) => {
      await store.register(key, replacement);
      return await compare(...args);
    });

    await expect(deleteShortTermLockEntryIfCurrent(store, key, expected)).resolves.toBe(false);
    expect(await store.lookup(key)).toEqual(replacement);
  });

  it("retries a conflict while preserving the owner and acquisition-time predicate", async () => {
    const store = createLockStore();
    await store.register(key, expected);
    const compare = store.compareAndApply.getMockImplementation()!;
    store.compareAndApply.mockImplementationOnce(async (...args) => {
      await store.register(key, { ...expected, ownerStartTime: 456 });
      return await compare(...args);
    });

    await expect(deleteShortTermLockEntryIfCurrent(store, key, expected)).resolves.toBe(true);
    expect(await store.lookup(key)).toBeUndefined();
  });

  it("reports a missing lock as unchanged", async () => {
    const store = createLockStore();
    await expect(deleteShortTermLockEntryIfCurrent(store, key, expected)).resolves.toBe(false);
  });

  it.each(["observe", "compareAndApply"] as const)("does not retry a failed %s", async (method) => {
    const store = createLockStore();
    await store.register(key, expected);
    const failure = new Error("worker result unavailable");
    store[method].mockRejectedValue(failure);

    await expect(deleteShortTermLockEntryIfCurrent(store, key, expected)).rejects.toBe(failure);
    expect(store[method]).toHaveBeenCalledOnce();
    expect(await store.lookup(key)).toEqual(expected);
  });

  it("keeps a failed release best effort and recovers before the next owner runs", async () => {
    const store = createLockStore();
    const compare = store.compareAndApply.getMockImplementation()!;
    const failedDeletion = vi.fn(() => {
      throw new Error("worker result unavailable");
    });
    store.compareAndApply.mockImplementation(async (...args) =>
      args[2].action === "delete" ? failedDeletion() : compare(...args),
    );
    const firstTask = vi.fn(async () => "completed");
    await expect(withMemoryWorkspaceLock(key, firstTask)).resolves.toBe("completed");
    expect(failedDeletion).toHaveBeenCalledOnce();
    const completed = await store.lookup(key);
    expect(completed).toBeDefined();

    store.compareAndApply.mockImplementation(compare);
    await expect(
      withMemoryWorkspaceLock(key, async () => {
        expect(await store.lookup(key)).not.toEqual(completed);
        return "recovered";
      }),
    ).resolves.toBe("recovered");
    expect(firstTask).toHaveBeenCalledOnce();
    expect(await store.lookup(key)).toBeUndefined();
  });

  it("recovers an applied acquisition whose reply failed without replaying its task", async () => {
    const store = createLockStore();
    const compare = store.compareAndApply.getMockImplementation()!;
    const unavailable = new Error("worker acquisition result unavailable");
    store.compareAndApply.mockImplementationOnce(async (...args) => {
      expect(await compare(...args)).toEqual({ status: "applied" });
      throw unavailable;
    });
    const originalTask = vi.fn(async () => "must not run");
    await expect(withMemoryWorkspaceLock(key, originalTask)).rejects.toMatchObject({
      code: "MEMORY_WORKSPACE_LOCK_STORE_UNAVAILABLE",
      outcome: { kind: "store-unavailable", reason: "storage-error" },
      cause: unavailable,
    });
    const orphan = await store.lookup(key);
    expect(orphan).toBeDefined();
    expect(originalTask).not.toHaveBeenCalled();

    await expect(
      withMemoryWorkspaceLock(key, async () => {
        expect(await store.lookup(key)).not.toEqual(orphan);
        return "new owner";
      }),
    ).resolves.toBe("new owner");
    expect(originalTask).not.toHaveBeenCalled();
    expect(await store.lookup(key)).toBeUndefined();
  });

  it.each(["owner", "acquiredAt"] as const)(
    "preserves a live replacement with a different %s after failed cleanup",
    async (field) => {
      const store = createLockStore();
      const compare = store.compareAndApply.getMockImplementation()!;
      store.compareAndApply.mockImplementation(async (...args) => {
        if (args[2].action === "delete") {
          throw new Error("worker result unavailable");
        }
        return compare(...args);
      });
      await withMemoryWorkspaceLock(key, async () => "completed");
      const completed = await store.lookup(key);
      expect(completed).toBeDefined();
      if (!completed) {
        throw new Error("Expected the completed lease receipt");
      }
      const replacement = {
        ...completed,
        ...(field === "owner"
          ? { owner: `${process.pid}:independent-live-owner` }
          : { acquiredAt: completed.acquiredAt + 1 }),
      };
      await store.register(key, replacement);
      store.compareAndApply.mockImplementation(compare);
      const nextTask = vi.fn(async () => "must not run");
      await expect(withMemoryWorkspaceLock(key, nextTask)).rejects.toThrow(
        "Unexpected lock contention",
      );
      expect(nextTask).not.toHaveBeenCalled();
      expect(await store.lookup(key)).toEqual(replacement);
    },
  );

  it("retains an unknown fresh same-process lease without treating it as completed", async () => {
    const store = createLockStore();
    const unknown = { owner: `${process.pid}:unknown-owner`, acquiredAt: Date.now() };
    await store.register(key, unknown);
    const nextTask = vi.fn(async () => "must not run");
    await expect(withMemoryWorkspaceLock(key, nextTask)).rejects.toThrow(
      "Unexpected lock contention",
    );
    expect(nextTask).not.toHaveBeenCalled();
    expect(await store.lookup(key)).toEqual(unknown);
  });

  it.each(["observe", "compareAndApply"] as const)(
    "requires %s before deletion",
    async (method) => {
      const store: PluginStateKeyedStore<ShortTermLockEntry> = createLockStore();
      await store.register(key, expected);
      store[method] = undefined;
      await expect(deleteShortTermLockEntryIfCurrent(store, key, expected)).rejects.toThrow(
        "memory-core short-term lock store requires atomic comparisons",
      );
      expect(await store.lookup(key)).toEqual(expected);
    },
  );
});
