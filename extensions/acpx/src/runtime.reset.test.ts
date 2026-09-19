import { AcpxRuntime as BaseAcpxRuntime } from "acpx/runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpSessionStore } from "./runtime.js";
import { type TestSessionStore, makeRuntime, makeManagedRuntime } from "./runtime.test-support.js";

describe("AcpxRuntime reset generation custody", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("keeps stale persistent loads hidden until a fresh record is saved", async () => {
    let persisted: Record<string, unknown> = { acpxRecordId: "stale" };
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => persisted),
      save: vi.fn(async (record) => {
        persisted = record;
      }),
    };

    const { runtime, wrappedStore } = makeRuntime(baseStore);

    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toEqual({
      acpxRecordId: "stale",
    });
    expect(baseStore["load"]).toHaveBeenCalledTimes(1);

    await runtime.prepareFreshSession({
      sessionKey: "agent:codex:acp:binding:test",
    });

    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toBeUndefined();
    expect(baseStore["load"]).toHaveBeenCalledTimes(1);
    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toBeUndefined();
    expect(baseStore["load"]).toHaveBeenCalledTimes(1);

    await wrappedStore.save({
      acpxRecordId: "agent:codex:acp:binding:test",
      name: "agent:codex:acp:binding:test",
      acpSessionId: "fresh-session",
    } as never);

    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toMatchObject({
      acpxRecordId: "agent:codex:acp:binding:test",
      acpSessionId: "fresh-session",
    });
    expect(baseStore["load"]).toHaveBeenCalledTimes(2);
  });

  it("fences persistence from a runtime option that finishes after reset", async () => {
    const sessionKey = "agent:codex:acp:binding:test";
    const oldRecord = { acpxRecordId: "old-record", name: sessionKey, acpSessionId: "old-session" };
    let persisted: Record<string, unknown> = oldRecord;
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => persisted),
      save: vi.fn(async (record) => {
        persisted = record;
      }),
    };
    const { runtime, wrappedStore, delegate } = makeRuntime(baseStore);
    let release: (() => void) | undefined;
    vi.spyOn(delegate, "setMode").mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await wrappedStore.save({ ...oldRecord, sessionMode: "stale" });
    });
    const pending = runtime.setMode({
      handle: { sessionKey, backend: "acpx", runtimeSessionName: sessionKey },
      mode: "stale",
    });
    await vi.waitFor(() => expect(release).toEqual(expect.any(Function)));
    await runtime.prepareFreshSession({ sessionKey });
    await wrappedStore.save({
      acpxRecordId: "fresh-record",
      name: sessionKey,
      acpSessionId: "fresh-session",
    });
    release?.();
    await pending;
    expect(persisted).toMatchObject({ acpSessionId: "fresh-session" });
  });

  it("keeps a fresh generation owned when an older discard close finishes late", async () => {
    const sessionKey = "agent:codex:acp:binding:test";
    const oldRecord: Record<string, unknown> = {
      acpxRecordId: sessionKey,
      name: sessionKey,
      acpSessionId: "old-session",
    };
    let persisted = oldRecord;
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => persisted),
      save: vi.fn(async (record) => {
        persisted = record;
      }),
    };
    const { runtime, wrappedStore, delegate } = makeRuntime(baseStore, {
      openclawToolsMcpBridgeEnabled: true,
      mcpServers: [
        {
          name: "openclaw-tools",
          command: "node",
          args: ["dist/mcp/openclaw-tools-serve.js"],
          env: [],
        },
      ],
    });
    let releaseClose: (() => void) | undefined;
    vi.spyOn(delegate, "close").mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
      oldRecord.closed = true;
      oldRecord.acpx = { reset_on_next_ensure: true };
      await wrappedStore.save(oldRecord);
    });

    const closePromise = runtime.close({
      handle: {
        sessionKey,
        backend: "acpx",
        runtimeSessionName: sessionKey,
      },
      reason: "new-in-place-reset",
      discardPersistentState: true,
    });
    await vi.waitFor(() => expect(releaseClose).toEqual(expect.any(Function)));
    await runtime.prepareFreshSession({ sessionKey });
    await wrappedStore.save({
      acpxRecordId: sessionKey,
      name: sessionKey,
      acpSessionId: "fresh-session",
    });

    releaseClose?.();
    await closePromise;

    expect(persisted).toMatchObject({ acpSessionId: "fresh-session" });
    expect(await wrappedStore.load(sessionKey)).toMatchObject({ acpSessionId: "fresh-session" });
  });

  it("keeps a background discard close attached to the pre-reset record", async () => {
    const sessionKey = "agent:codex:acp:binding:test";
    const oldRecord: Record<string, unknown> = {
      acpxRecordId: sessionKey,
      name: sessionKey,
      acpSessionId: "old-session",
    };
    const load = vi.fn(async () => oldRecord);
    const baseStore: TestSessionStore = {
      load,
      save: vi.fn(async () => {}),
    };
    const { runtime, wrappedStore, delegate } = makeRuntime(baseStore);
    await expect(wrappedStore.load(sessionKey)).resolves.toBe(oldRecord);
    const baseLoadCount = load.mock.calls.length;
    const close = vi.spyOn(delegate, "close").mockImplementation(async () => {
      expect(await wrappedStore.load(sessionKey)).toMatchObject(oldRecord);
    });

    const closePromise = runtime.close({
      handle: {
        sessionKey,
        backend: "acpx",
        runtimeSessionName: sessionKey,
      },
      reason: "new-in-place-reset",
      discardPersistentState: true,
    });
    await runtime.prepareFreshSession({ sessionKey });
    await closePromise;

    expect(close).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledTimes(baseLoadCount + 1);
  });

  it("marks the session fresh after discardPersistentState close", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({ acpxRecordId: "stale" }) as never),
      save: vi.fn(async () => {}),
    };

    const { runtime, wrappedStore, delegate } = makeRuntime(baseStore);
    const close = vi.spyOn(delegate, "close").mockResolvedValue(undefined);

    await runtime.close({
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
      reason: "new-in-place-reset",
      discardPersistentState: true,
    });

    expect(close).toHaveBeenCalledWith({
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
      reason: "new-in-place-reset",
      discardPersistentState: true,
    });
    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toBeUndefined();
    expect(baseStore["load"]).toHaveBeenCalledOnce();
  });

  it.each(["success", "cleanup-failure", "close-failure"] as const)(
    "preserves persisted session ownership through %s",
    async (outcome) => {
      const { runtime, target, baseStore, sleep, ensure } = makeManagedRuntime();
      const handle = await ensure();
      if (outcome === "cleanup-failure") {
        sleep.mockRejectedValueOnce(new Error("cleanup failed"));
      }
      if (outcome === "close-failure") {
        baseStore.save.mockRejectedValueOnce(new Error("close failed"));
      }
      const closing = runtime.close({ handle, reason: "closed" });
      if (outcome === "success") {
        await closing;
      } else {
        await expect(closing).rejects.toThrow(
          outcome === "cleanup-failure" ? "cleanup failed" : "close failed",
        );
      }
      expect((await baseStore.load()).closed).toBe(outcome !== "close-failure");
      const next = await ensure();
      expect(next.sessionKey).toBe(target.sessionKey);
      expect(next.agentId).toBe(target.agentId);
      expect(next.backendSessionId).toBe(handle.backendSessionId);
      await runtime.close({ handle: next, reason: "closed" });
      await runtime.shutdown();
    },
  );

  it.each([false, true])(
    "keeps successor persistence when overlapping predecessor closes settle (prior reset: %s)",
    async (afterReset) => {
      const { runtime, target, baseStore, ensure } = makeManagedRuntime();
      let handle = await ensure();
      const wrappedStore = Reflect.get(runtime, "sessionStore") as AcpSessionStore;
      async function ensureFresh(id: string) {
        const freshRecord = { ...(await baseStore.load()), acpSessionId: id, closed: false };
        const create = vi
          .spyOn(BaseAcpxRuntime.prototype, "ensureSession")
          .mockImplementationOnce(async () => {
            await wrappedStore.save(freshRecord);
            return { ...handle, backendSessionId: id };
          });
        try {
          return await ensure();
        } finally {
          create.mockRestore();
        }
      }
      if (afterReset) {
        await runtime.prepareFreshSession(target);
        handle = await ensureFresh("prior-reset-session");
      }
      const closingStarted = createDeferred<void>();
      const releaseClose = createDeferred<void>();
      const save = baseStore.save.getMockImplementation()!;
      baseStore.save.mockImplementationOnce(async (record) => {
        closingStarted.resolve();
        await releaseClose.promise;
        await save(record);
      });
      const firstClose = runtime.close({ handle, reason: "older close" });
      let secondClose: Promise<void> | undefined;
      try {
        await closingStarted.promise;
        secondClose = runtime.close({ handle, reason: "concurrent close" });
        await runtime.prepareFreshSession(target);
        const successor = ensureFresh("successor-session");
        // The storage writer remains serialized, but the retired runtime does
        // not own the successor's queue or the final persisted session.
        releaseClose.resolve();
        const next = await successor;
        await Promise.all([firstClose, secondClose]);
        expect(next.backendSessionId).toBe("successor-session");
        expect((await baseStore.load()).acpSessionId).toBe("successor-session");
        expect((await baseStore.load()).closed).toBe(false);
        await runtime.close({ handle: next, reason: "final close" });
        await runtime.shutdown();
      } finally {
        releaseClose.resolve();
        await Promise.allSettled([firstClose, ...(secondClose ? [secondClose] : [])]);
      }
    },
  );
  it("keeps ordinary close and reopen off the blocked pre-reset runtime", async () => {
    const { runtime, target, baseStore, ensure } = makeManagedRuntime();
    const handle = await ensure();
    const original = Reflect.get(runtime, "delegate") as BaseAcpxRuntime;
    await runtime.prepareFreshSession(target);
    const wrappedStore = Reflect.get(runtime, "sessionStore") as AcpSessionStore;
    const freshRecord = { ...(await baseStore.load()), acpSessionId: "isolated-successor" };
    const create = vi
      .spyOn(BaseAcpxRuntime.prototype, "ensureSession")
      .mockImplementationOnce(async () => {
        await wrappedStore.save(freshRecord);
        return { ...handle, backendSessionId: freshRecord.acpSessionId };
      });
    const successor = await ensure();
    const successorRuntime = create.mock.contexts[0];
    create.mockRestore();
    if (!(successorRuntime instanceof BaseAcpxRuntime)) {
      throw new Error("Fresh session did not use an ACPX runtime");
    }
    const shutdown = vi.spyOn(successorRuntime, "shutdown");
    const blocked = vi
      .spyOn(original, "ensureSession")
      .mockRejectedValue(new Error("pre-reset runtime is still blocked"));
    try {
      await runtime.close({ handle: successor, reason: "ordinary close" });
      expect(shutdown).toHaveBeenCalledOnce();
      await shutdown.mock.results[0]!.value;
      const reopened = await ensure();
      expect(reopened.backendSessionId).toBe(successor.backendSessionId);
      expect(blocked).not.toHaveBeenCalled();
      await runtime.close({ handle: reopened, reason: "final close" });
    } finally {
      await runtime.shutdown();
    }
  });

  it("does not allocate a reset runtime after shutdown during a close snapshot", async () => {
    const { runtime, target, baseStore, ensure } = makeManagedRuntime();
    const previous = await ensure();
    await runtime.prepareFreshSession(target);
    // A persisted handle has no process-local generation symbol.
    const handle = {
      ...target,
      backend: previous.backend,
      runtimeSessionName: previous.runtimeSessionName,
      backendSessionId: previous.backendSessionId,
    };
    const record = await baseStore.load();
    const snapshotStarted = createDeferred<void>();
    const releaseSnapshot = createDeferred<void>();
    baseStore.load.mockImplementationOnce(async () => {
      snapshotStarted.resolve();
      await releaseSnapshot.promise;
      return record;
    });
    const close = vi.spyOn(BaseAcpxRuntime.prototype, "close");
    const closing = runtime.close({ handle, reason: "discard", discardPersistentState: true });
    void closing.catch(() => {});
    try {
      await snapshotStarted.promise;
      await runtime.shutdown();
      releaseSnapshot.resolve();
      await expect(closing).rejects.toThrow("ACP runtime is shut down");
      expect(close).not.toHaveBeenCalled();
    } finally {
      releaseSnapshot.resolve();
      await Promise.allSettled([closing]);
      await runtime.shutdown();
    }
  });

  it("waits for every post-reset runtime during service shutdown and rejects new work", async () => {
    const { runtime, target, baseStore, ensure } = makeManagedRuntime();
    const handle = await ensure();
    await runtime.prepareFreshSession(target);
    const wrappedStore = Reflect.get(runtime, "sessionStore") as AcpSessionStore;
    const freshRecord = { ...(await baseStore.load()), acpSessionId: "shutdown-successor" };
    const create = vi
      .spyOn(BaseAcpxRuntime.prototype, "ensureSession")
      .mockImplementationOnce(async () => {
        await wrappedStore.save(freshRecord);
        return { ...handle, backendSessionId: freshRecord.acpSessionId };
      });
    await ensure();
    const successorRuntime = create.mock.contexts[0];
    create.mockRestore();
    const successorShutdownStarted = createDeferred<void>();
    const releaseShutdown = createDeferred<void>();
    const shutdown = vi
      .spyOn(BaseAcpxRuntime.prototype, "shutdown")
      .mockImplementation(async function (this: BaseAcpxRuntime) {
        if (this === successorRuntime) {
          successorShutdownStarted.resolve();
          await releaseShutdown.promise;
        }
      });
    let settled = false;
    const closing = runtime.shutdown().then(() => {
      settled = true;
    });
    try {
      await Promise.race([
        successorShutdownStarted.promise,
        closing.then(() => {
          throw new Error("Shutdown settled before reaching the successor runtime");
        }),
      ]);
      expect(settled).toBe(false);
      await expect(ensure()).rejects.toThrow("ACP runtime is shut down");
      releaseShutdown.resolve();
      await closing;
      expect(shutdown).toHaveBeenCalledTimes(2);
    } finally {
      releaseShutdown.resolve();
      await closing;
    }
  });
});
