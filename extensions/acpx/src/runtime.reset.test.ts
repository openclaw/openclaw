import { AcpxRuntime as BaseAcpxRuntime, RequestedModelUnsupportedError } from "acpx/runtime";
import type { AcpSessionStore } from "acpx/runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type TestSessionStore, makeRuntime, makeManagedRuntime } from "./runtime.test-support.js";

const resetSessionKey = "agent:codex:acp:binding:test";
const resetHandle = {
  sessionKey: resetSessionKey,
  backend: "acpx",
  runtimeSessionName: resetSessionKey,
};
const freshRecord = {
  acpxRecordId: resetSessionKey,
  name: resetSessionKey,
  acpSessionId: "fresh-session",
};

function makePersistedRuntime(acpxRecordId = resetSessionKey) {
  const oldRecord: Record<string, unknown> = {
    acpxRecordId,
    name: resetSessionKey,
    acpSessionId: "old-session",
  };
  let persisted = oldRecord;
  const baseStore = {
    load: vi.fn<TestSessionStore["load"]>(async () => persisted),
    save: vi.fn<TestSessionStore["save"]>(async (record) => {
      persisted = record;
    }),
  };
  return { ...makeRuntime(baseStore), baseStore, oldRecord };
}

async function ensureFresh(
  { runtime, baseStore, ensure }: ReturnType<typeof makeManagedRuntime>,
  handle: Awaited<ReturnType<typeof ensure>>,
  id: string,
) {
  const wrappedStore: AcpSessionStore = Reflect.get(runtime, "sessionStore");
  const record = { ...(await baseStore.load()), acpSessionId: id, closed: false };
  const create = vi
    .spyOn(BaseAcpxRuntime.prototype, "ensureSession")
    .mockImplementationOnce(async () => {
      await wrappedStore.save(record);
      return { ...handle, backendSessionId: id };
    });
  try {
    const next = await ensure();
    const delegate = create.mock.contexts[0];
    if (!(delegate instanceof BaseAcpxRuntime)) {
      throw new Error("Fresh session did not use an ACPX runtime");
    }
    return { handle: next, delegate };
  } finally {
    create.mockRestore();
  }
}

describe("AcpxRuntime reset generation custody", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("keeps stale persistent loads hidden until a fresh record is saved", async () => {
    const { runtime, wrappedStore, baseStore, oldRecord } = makePersistedRuntime("stale");
    expect(await wrappedStore.load(resetSessionKey)).toEqual(oldRecord);
    expect(baseStore.load).toHaveBeenCalledOnce();
    await runtime.prepareFreshSession({ sessionKey: resetSessionKey });
    expect(await wrappedStore.load(resetSessionKey)).toBeUndefined();
    expect(await wrappedStore.load(resetSessionKey)).toBeUndefined();
    expect(baseStore.load).toHaveBeenCalledOnce();
    await wrappedStore.save(freshRecord);
    expect(await wrappedStore.load(resetSessionKey)).toMatchObject({
      acpxRecordId: resetSessionKey,
      acpSessionId: "fresh-session",
    });
    expect(baseStore.load).toHaveBeenCalledTimes(2);
  });

  it("fences persistence from a runtime option that finishes after reset", async () => {
    const { runtime, wrappedStore, delegate, baseStore, oldRecord } =
      makePersistedRuntime("old-record");
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    vi.spyOn(delegate, "setMode").mockImplementation(async () => {
      started.resolve();
      await release.promise;
      await wrappedStore.save({ ...oldRecord, sessionMode: "stale" });
    });
    const pending = runtime.setMode({ handle: resetHandle, mode: "stale" });
    try {
      await started.promise;
      await runtime.prepareFreshSession({ sessionKey: resetSessionKey });
      await wrappedStore.save({ ...freshRecord, acpxRecordId: "fresh-record" });
      release.resolve();
      await pending;
      expect(await baseStore.load(resetSessionKey)).toMatchObject({
        acpSessionId: "fresh-session",
      });
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
      await runtime.shutdown();
    }
  });

  it.each(["startup", "control"])(
    "does not retry a model reference after reset during %s rejection",
    async (operation) => {
      const sessionKey = "agent:catalog:acp:model-reset";
      const { runtime, delegate } = makeRuntime({
        load: vi.fn(async () => undefined),
        save: vi.fn(async () => {}),
      });
      const started = createDeferred<void>();
      const release = createDeferred<void>();
      const rejectModel = async (): Promise<never> => {
        started.resolve();
        await release.promise;
        throw new RequestedModelUnsupportedError("Model is not advertised", "unadvertised-model");
      };
      const ensure = vi.spyOn(delegate, "ensureSession").mockImplementation(rejectModel);
      const control = vi.spyOn(delegate, "setConfigOption").mockImplementation(rejectModel);
      const pending =
        operation === "startup"
          ? runtime.ensureSession({
              sessionKey,
              agent: "catalog",
              mode: "persistent",
              model: "provider/model",
              modelExplicit: true,
            })
          : runtime.setConfigOption({
              handle: { sessionKey, backend: "acpx", runtimeSessionName: sessionKey },
              key: "model",
              value: "provider/model",
            });
      const rejected = expect(pending).rejects.toThrow("superseded by reset");
      try {
        await started.promise;
        await runtime.prepareFreshSession({ sessionKey });
        release.resolve();
        await rejected;
        expect(operation === "startup" ? ensure : control).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await Promise.allSettled([pending]);
        await runtime.shutdown();
      }
    },
  );

  it("keeps a fresh generation owned when an older discard close finishes late", async () => {
    const { runtime, wrappedStore, delegate, baseStore, oldRecord } = makePersistedRuntime();
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const close = vi.spyOn(delegate, "close").mockImplementation(async () => {
      started.resolve();
      await release.promise;
      expect(await wrappedStore.load(resetSessionKey)).toBe(oldRecord);
      oldRecord.closed = true;
      oldRecord.acpx = { reset_on_next_ensure: true };
      await wrappedStore.save(oldRecord);
    });
    const input = {
      handle: resetHandle,
      reason: "new-in-place-reset",
      discardPersistentState: true,
    };
    const closing = runtime.close(input);
    try {
      await started.promise;
      expect(close).toHaveBeenCalledExactlyOnceWith(input);
      expect(await wrappedStore.load(resetSessionKey)).toBeUndefined();
      expect(baseStore.load).toHaveBeenCalledOnce();
      await runtime.prepareFreshSession({ sessionKey: resetSessionKey });
      await wrappedStore.save(freshRecord);
      release.resolve();
      await closing;
      expect(baseStore.load).toHaveBeenCalledTimes(2);
      expect(await baseStore.load(resetSessionKey)).toMatchObject({
        acpSessionId: "fresh-session",
      });
      expect(await wrappedStore.load(resetSessionKey)).toMatchObject({
        acpSessionId: "fresh-session",
      });
    } finally {
      release.resolve();
      await Promise.allSettled([closing]);
      await runtime.shutdown();
    }
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
      const fixture = makeManagedRuntime();
      const { runtime, target, baseStore, ensure } = fixture;
      let handle = await ensure();
      if (afterReset) {
        await runtime.prepareFreshSession(target);
        handle = (await ensureFresh(fixture, handle, "prior-reset-session")).handle;
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
        const successor = ensureFresh(fixture, handle, "successor-session");
        // The storage writer remains serialized, but the retired runtime does
        // not own the successor's queue or the final persisted session.
        releaseClose.resolve();
        const { handle: next } = await successor;
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
    const fixture = makeManagedRuntime();
    const { runtime, target, ensure } = fixture;
    const handle = await ensure();
    const original = Reflect.get(runtime, "delegate") as BaseAcpxRuntime;
    await runtime.prepareFreshSession(target);
    const { handle: successor, delegate: successorRuntime } = await ensureFresh(
      fixture,
      handle,
      "isolated-successor",
    );
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
    const fixture = makeManagedRuntime();
    const { runtime, target, ensure } = fixture;
    const handle = await ensure();
    await runtime.prepareFreshSession(target);
    const { delegate: successorRuntime } = await ensureFresh(fixture, handle, "shutdown-successor");
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
