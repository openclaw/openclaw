import { DatabaseSync } from "node:sqlite";
import type {
  PluginStateOperation,
  PluginStateOperationDefinitions,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReefInboxCursorStore } from "./state.js";
import {
  beforeNextStateOperation,
  cleanupStateTestDirectory,
  createRuntime as createStateRuntime,
  createStateTestDirectory,
  expectReefStateOperationError,
} from "./state.test-support.js";

const binding = { handle: "molty", relayUrl: "https://reefwire.ai" };
const options = { namespace: "inbox-cursor", maxEntries: 1, overflowPolicy: "reject-new" as const };

describe("Reef inbox cursor persistence", () => {
  let stateDir: string;
  let runtime: ReturnType<typeof createStateRuntime>;
  const cursor = (signal?: AbortSignal) => new ReefInboxCursorStore(runtime, binding, signal);

  beforeEach(() => {
    stateDir = createStateTestDirectory();
    runtime = createStateRuntime(stateDir);
  });
  afterEach(() => cleanupStateTestDirectory(stateDir));
  it("preserves monotonic progress", async () => {
    const requested = { ...binding };
    const first = new ReefInboxCursorStore(runtime, requested);
    requested.handle = "changed";
    const second = cursor();
    await expect(first.load()).resolves.toBe(0);
    await Promise.all([first.advance(12), second.advance(7), second.advance(20)]);
    await expect(
      new ReefInboxCursorStore(createStateRuntime(stateDir), binding).load(),
    ).resolves.toBe(20);
    await expect(first.advance(-1)).rejects.toThrow("invalid Reef inbox cursor");
    await expect(first.load()).resolves.toBe(20);
    await expectReefStateOperationError(
      new ReefInboxCursorStore(runtime, { ...binding, handle: "clawd" }).load(),
      "Reef inbox cursor belongs to a different identity",
    );
  });

  it("uses one operation per cursor call without application-thread SQL", async () => {
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const store = cursor();
    const backing = runtime.stateStores[0]!;
    const createOperation = backing.createOperation!;
    const commands: string[] = [];
    backing.createOperation = <Operations extends PluginStateOperationDefinitions>(
      ...args: Parameters<typeof createOperation>
    ): PluginStateOperation<Operations> => {
      const operation = createOperation<Operations>(...args);
      return {
        execute(command, selection) {
          commands.push(command.type);
          return operation.execute(command, selection);
        },
      };
    };
    expect(await store.load()).toBe(0);
    await store.advance(12);
    await store.advance(7);
    expect(await store.load()).toBe(12);
    expect(commands).toEqual(["cursor.load", "cursor.advance", "cursor.advance", "cursor.load"]);
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each(["advance", "load"] as const)(
    "refuses cursor %s when authority expires across worker admission or read completion",
    async (method) => {
      const store = cursor();
      await store.advance(12);
      const entered = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const controller = new AbortController();
      const refusal = new Error("inbox authority expired");
      const pause = async () => {
        entered.resolve();
        await released.promise;
      };
      beforeNextStateOperation(runtime, pause, method === "advance" ? "before" : "after");
      const native = vi.spyOn(runtime.state, "openSyncKeyedStore");
      const guarded = cursor(controller.signal);
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
      const competing = runtime.state.openKeyedStoreV2(options);
      beforeNextStateOperation(runtime, () =>
        competing.register("current", {
          ...binding,
          ...(change === "different identity" ? { handle: "clawd" } : {}),
          cursor: 40,
        }),
      );
      const store = cursor();
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
    const competing = runtime.state.openKeyedStoreV2(options);
    await competing.register("current", { ...binding, handle: "clawd", cursor: 3 });
    beforeNextStateOperation(runtime, () =>
      competing.register("current", { ...binding, cursor: 5 }),
    );
    const store = cursor();
    await store.advance(12);
    await expect(store.load()).resolves.toBe(12);
  });

  it("refuses invalid stored state", async () => {
    const raw = runtime.state.openKeyedStoreV2(options);
    await raw.register("current", { ...binding, cursor: "invalid" });
    const store = cursor();
    await expectReefStateOperationError(store.load(), "invalid Reef inbox cursor state");
    await expectReefStateOperationError(store.advance(12), "invalid Reef inbox cursor state");
    await expect(raw.lookup("current")).resolves.toEqual({ ...binding, cursor: "invalid" });
  });

  it("propagates a failed operation without falling back to native writes", async () => {
    const failure = new Error("worker operation unavailable");
    beforeNextStateOperation(runtime, () => {
      throw failure;
    });
    const native = vi.spyOn(runtime.state, "openSyncKeyedStore");
    const store = cursor();
    await expect(store.advance(12)).rejects.toBe(failure);
    await expect(store.load()).resolves.toBe(0);
    expect(native).not.toHaveBeenCalled();
  });
});
