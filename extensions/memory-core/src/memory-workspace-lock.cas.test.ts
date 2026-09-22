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
      throw new Error("Unexpected lock update");
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

  it("keeps release failures best effort without replaying an uncertain result", async () => {
    const store = createLockStore();
    store.compareAndApply.mockRejectedValue(new Error("worker result unavailable"));
    await expect(withMemoryWorkspaceLock(key, async () => "completed")).resolves.toBe("completed");
    expect(store.compareAndApply).toHaveBeenCalledOnce();
    expect(await store.lookup(key)).toBeDefined();
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
