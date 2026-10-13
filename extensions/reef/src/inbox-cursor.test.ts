import { DatabaseSync } from "node:sqlite";
import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
  PluginStateOperation,
  PluginStateOperationDefinitions,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReefInboxCursorStore } from "./state.js";
import { expectReefStateOperationError } from "./state.test-support.js";

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

  function createRuntime(host: "worker" | "native" = "worker") {
    const runtime = createPluginRuntimeMock();
    const commands: string[] = [];
    const hooks: { before?: () => Promise<void> | void; after?: () => Promise<void> | void } = {};
    runtime.state.openKeyedStore = <T>(storeOptions: OpenAsyncKeyedStoreOptions) => {
      const store: PluginStateKeyedStore<T> = createPluginStateKeyedStoreForTests<T>("reef", {
        ...storeOptions,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
      if (host === "native") {
        delete store.createOperation;
      } else {
        const createOperation = store.createOperation!;
        store.createOperation = <Operations extends PluginStateOperationDefinitions>(
          ...args: Parameters<typeof createOperation>
        ): PluginStateOperation<Operations> => {
          const operation = createOperation<Operations>(...args);
          return {
            async execute(command, selection) {
              commands.push(command.type);
              const before = hooks.before;
              hooks.before = undefined;
              await before?.();
              const result = await operation.execute(command, selection);
              const after = hooks.after;
              hooks.after = undefined;
              await after?.();
              return result;
            },
          };
        };
      }
      return store;
    };
    runtime.state.openSyncKeyedStore = <T>(storeOptions: OpenKeyedStoreOptions) =>
      createPluginStateSyncKeyedStoreForTests<T>("reef", {
        ...storeOptions,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
    return Object.assign(runtime, { commands, hooks });
  }

  it.each(["worker", "native"] as const)(
    "preserves monotonic progress on a %s host",
    async (host) => {
      const runtime = createRuntime(host);
      const first = new ReefInboxCursorStore(runtime, binding);
      const second = new ReefInboxCursorStore(runtime, binding);
      await Promise.all([first.advance(12), second.advance(7), second.advance(20)]);
      await expect(new ReefInboxCursorStore(runtime, binding).load()).resolves.toBe(20);
      await expect(first.advance(-1)).rejects.toThrow("invalid Reef inbox cursor");
      await expect(first.load()).resolves.toBe(20);
    },
  );

  it("uses one operation per cursor call without application-thread SQL", async () => {
    const runtime = createRuntime();
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const store = new ReefInboxCursorStore(runtime, binding);
    expect(await store.load()).toBe(0);
    await store.advance(12);
    await store.advance(7);
    expect(await store.load()).toBe(12);
    expect(runtime.commands).toEqual([
      "cursor.load",
      "cursor.advance",
      "cursor.advance",
      "cursor.load",
    ]);
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each(["advance", "load"] as const)(
    "refuses cursor %s when authority expires across worker admission or read completion",
    async (method) => {
      const runtime = createRuntime();
      const store = new ReefInboxCursorStore(runtime, binding);
      await store.advance(12);
      const entered = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const controller = new AbortController();
      const refusal = new Error("inbox authority expired");
      const pause = async () => {
        entered.resolve();
        await released.promise;
      };
      if (method === "advance") {
        runtime.hooks.before = pause;
      } else {
        runtime.hooks.after = pause;
      }
      const native = vi.spyOn(runtime.state, "openSyncKeyedStore");
      const guarded = new ReefInboxCursorStore(runtime, binding, controller.signal);
      const pending = method === "advance" ? guarded.advance(13) : guarded.load();
      const rejected = expect(pending).rejects.toBe(refusal);
      try {
        await entered.promise;
        controller.abort(refusal);
      } finally {
        released.resolve();
      }
      await rejected;
      await expect(store.load()).resolves.toBe(12);
      expect(native).not.toHaveBeenCalled();
    },
  );

  it.each(["higher cursor", "different identity"] as const)(
    "observes a foreign %s committed before cursor admission",
    async (change) => {
      const runtime = createRuntime();
      const competing = runtime.state.openKeyedStore(options);
      runtime.hooks.before = () =>
        competing.register("current", {
          ...binding,
          ...(change === "different identity" ? { handle: "clawd" } : {}),
          cursor: 40,
        });
      const store = new ReefInboxCursorStore(runtime, binding);
      if (change === "different identity") {
        await expectReefStateOperationError(
          store.advance(12),
          "Reef inbox cursor belongs to a different identity",
        );
      } else {
        await store.advance(12);
        await expect(store.load()).resolves.toBe(40);
      }
      await expect(competing.lookup("current")).resolves.toMatchObject({
        handle: change === "different identity" ? "clawd" : "molty",
        cursor: 40,
      });
    },
  );

  it("uses a repair committed before its worker transaction", async () => {
    const runtime = createRuntime();
    const competing = runtime.state.openKeyedStore(options);
    await competing.register("current", { ...binding, handle: "clawd", cursor: 3 });
    runtime.hooks.before = () => competing.register("current", { ...binding, cursor: 5 });
    const store = new ReefInboxCursorStore(runtime, binding);
    await store.advance(12);
    await expect(store.load()).resolves.toBe(12);
  });

  it.each(["worker", "native"] as const)(
    "refuses invalid stored state on a %s host",
    async (host) => {
      const runtime = createRuntime(host);
      const raw = runtime.state.openKeyedStore(options);
      await raw.register("current", { ...binding, cursor: "invalid" });
      const store = new ReefInboxCursorStore(runtime, binding);
      if (host === "native") {
        await expect(store.load()).rejects.toThrow("invalid Reef inbox cursor state");
        await expect(store.advance(12)).rejects.toMatchObject({
          code: "PLUGIN_STATE_WRITE_FAILED",
          operation: "register",
          message: "Failed to update plugin state entry.",
          cause: expect.objectContaining({ message: "invalid Reef inbox cursor state" }),
        });
      } else {
        await expectReefStateOperationError(store.load(), "invalid Reef inbox cursor state");
        await expectReefStateOperationError(store.advance(12), "invalid Reef inbox cursor state");
      }
      await expect(raw.lookup("current")).resolves.toEqual({ ...binding, cursor: "invalid" });
    },
  );

  it("propagates a failed operation without falling back to native writes", async () => {
    const runtime = createRuntime();
    const failure = new Error("worker operation unavailable");
    runtime.hooks.before = () => {
      throw failure;
    };
    const native = vi.spyOn(runtime.state, "openSyncKeyedStore");
    const store = new ReefInboxCursorStore(runtime, binding);
    await expect(store.advance(12)).rejects.toBe(failure);
    await expect(store.load()).resolves.toBe(0);
    expect(native).not.toHaveBeenCalled();
  });
});
