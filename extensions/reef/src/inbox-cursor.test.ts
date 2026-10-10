import { DatabaseSync } from "node:sqlite";
import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreV2ForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReefInboxCursorStore } from "./state.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const binding = { handle: "molty", relayUrl: "https://reefwire.ai" };
const options = { namespace: "inbox-cursor", maxEntries: 1, overflowPolicy: "reject-new" as const };

describe("Reef inbox cursor persistence", () => {
  let stateDir: string;

  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = tempDirs.make("reef-inbox-cursor-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
  });

  function createRuntime() {
    const runtime = createPluginRuntimeMock();
    runtime.state.openKeyedStoreV2 = <T>(storeOptions: OpenAsyncKeyedStoreOptions) => {
      return createPluginStateKeyedStoreV2ForTests<T>(
        "reef",
        {
          ...storeOptions,
          env: { OPENCLAW_STATE_DIR: stateDir },
        },
        { assertCurrent() {} },
      );
    };
    runtime.state.openSyncKeyedStore = <T>(storeOptions: OpenKeyedStoreOptions) =>
      createPluginStateSyncKeyedStoreForTests<T>("reef", {
        ...storeOptions,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
    return runtime;
  }

  function beforeFirstComparison(
    runtime: ReturnType<typeof createRuntime>,
    change: () => Promise<void>,
  ) {
    const open = runtime.state.openKeyedStoreV2;
    let changed = false;
    runtime.state.openKeyedStoreV2 = <T>(storeOptions: OpenAsyncKeyedStoreOptions) => {
      const store = open<T>(storeOptions);
      const compareAndApply = store.compareAndApply!;
      return {
        ...store,
        compareAndApply: async (...args: Parameters<typeof compareAndApply>) => {
          if (!changed) {
            changed = true;
            await change();
          }
          return compareAndApply(...args);
        },
      };
    };
  }

  it("preserves monotonic progress across worker handles", async () => {
    const runtime = createRuntime();
    const first = new ReefInboxCursorStore(runtime, binding);
    const second = new ReefInboxCursorStore(runtime, binding);
    await Promise.all([first.advance(12), second.advance(7), second.advance(20)]);
    await expect(new ReefInboxCursorStore(runtime, binding).load()).resolves.toBe(20);
    await expect(first.advance(-1)).rejects.toThrow("invalid Reef inbox cursor");
    await expect(first.load()).resolves.toBe(20);
  });

  it("loads and advances without application-thread SQL", async () => {
    const runtime = createRuntime();
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const store = new ReefInboxCursorStore(runtime, binding);
    expect(await store.load()).toBe(0);
    await store.advance(12);
    await store.advance(7);
    expect(await store.load()).toBe(12);
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each(["higher cursor", "different identity"])(
    "revalidates a conflicting %s before advancing",
    async (conflict) => {
      const runtime = createRuntime();
      const competing = runtime.state.openKeyedStoreV2(options);
      beforeFirstComparison(runtime, async () => {
        await competing.register("current", {
          ...binding,
          ...(conflict === "different identity" ? { handle: "clawd" } : {}),
          cursor: 40,
        });
      });
      const store = new ReefInboxCursorStore(runtime, binding);
      if (conflict === "different identity") {
        await expect(store.advance(12)).rejects.toThrow("different identity");
      } else {
        await store.advance(12);
        await expect(store.load()).resolves.toBe(40);
      }
      await expect(competing.lookup("current")).resolves.toMatchObject({
        handle: conflict === "different identity" ? "clawd" : "molty",
        cursor: 40,
      });
    },
  );

  it("revalidates a repaired row instead of publishing a stale binding error", async () => {
    const runtime = createRuntime();
    const competing = runtime.state.openKeyedStoreV2(options);
    await competing.register("current", { ...binding, handle: "clawd", cursor: 3 });
    beforeFirstComparison(runtime, async () => {
      await competing.register("current", { ...binding, cursor: 5 });
    });
    const store = new ReefInboxCursorStore(runtime, binding);
    await store.advance(12);
    await expect(store.load()).resolves.toBe(12);
  });

  it("refuses invalid stored state without changing it", async () => {
    const runtime = createRuntime();
    const raw = runtime.state.openKeyedStoreV2(options);
    await raw.register("current", { ...binding, cursor: "invalid" });
    const store = new ReefInboxCursorStore(runtime, binding);
    await expect(store.load()).rejects.toThrow("invalid Reef inbox cursor state");
    await expect(store.advance(12)).rejects.toThrow("invalid Reef inbox cursor state");
    await expect(raw.lookup("current")).resolves.toEqual({ ...binding, cursor: "invalid" });
  });

  it("propagates a failed comparison without falling back to native writes", async () => {
    const runtime = createRuntime();
    const open = runtime.state.openKeyedStoreV2;
    const failure = new Error("comparison unavailable");
    runtime.state.openKeyedStoreV2 = <T>(storeOptions: OpenAsyncKeyedStoreOptions) => ({
      ...open<T>(storeOptions),
      compareAndApply: async () => {
        throw failure;
      },
    });
    const native = vi.spyOn(runtime.state, "openSyncKeyedStore");
    const store = new ReefInboxCursorStore(runtime, binding);
    await expect(store.advance(12)).rejects.toBe(failure);
    await expect(store.load()).resolves.toBe(0);
    expect(native).not.toHaveBeenCalled();
  });
});
