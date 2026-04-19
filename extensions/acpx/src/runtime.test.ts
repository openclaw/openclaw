import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpRuntime } from "../runtime-api.js";
import { AcpxRuntime } from "./runtime.js";

type TestSessionStore = {
  load(sessionId: string): Promise<Record<string, unknown> | undefined>;
  save(record: Record<string, unknown>): Promise<void>;
};

function makeRuntime(baseStore: TestSessionStore): {
  runtime: AcpxRuntime;
  wrappedStore: TestSessionStore & { markFresh: (sessionKey: string) => void };
  delegate: { close: AcpRuntime["close"] };
} {
  const runtime = new AcpxRuntime({
    cwd: "/tmp",
    sessionStore: baseStore,
    agentRegistry: {
      resolve: () => "codex",
      list: () => ["codex"],
    },
    permissionMode: "approve-reads",
  });

  return {
    runtime,
    wrappedStore: (
      runtime as unknown as {
        sessionStore: TestSessionStore & { markFresh: (sessionKey: string) => void };
      }
    ).sessionStore,
    delegate: (runtime as unknown as { delegate: { close: AcpRuntime["close"] } }).delegate,
  };
}

describe("AcpxRuntime fresh reset wrapper", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps stale persistent loads hidden until a fresh record is saved", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({ acpxRecordId: "stale" }) as never),
      save: vi.fn(async () => {}),
    };

    const { runtime, wrappedStore } = makeRuntime(baseStore);

    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toEqual({
      acpxRecordId: "stale",
    });
    expect(baseStore.load).toHaveBeenCalledTimes(1);

    await runtime.prepareFreshSession({
      sessionKey: "agent:codex:acp:binding:test",
    });

    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toBeUndefined();
    expect(baseStore.load).toHaveBeenCalledTimes(1);
    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toBeUndefined();
    expect(baseStore.load).toHaveBeenCalledTimes(1);

    await wrappedStore.save({
      acpxRecordId: "fresh-record",
      name: "agent:codex:acp:binding:test",
    } as never);

    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toEqual({
      acpxRecordId: "stale",
    });
    expect(baseStore.load).toHaveBeenCalledTimes(2);
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
    expect(baseStore.load).not.toHaveBeenCalled();
  });
});

describe("AcpxRuntime.ensureSession timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws after 15 seconds when the delegate never resolves", { timeout: 20_000 }, async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const runtime = new AcpxRuntime({
      cwd: "/tmp",
      sessionStore: baseStore,
      agentRegistry: { resolve: () => "codex", list: () => ["codex"] },
      permissionMode: "approve-reads",
    });

    // Patch delegate to hang forever
    const delegateEnsureSession = vi.fn(() => new Promise<never>(() => {}));
    (runtime as unknown as { delegate: { ensureSession: typeof delegateEnsureSession } }).delegate.ensureSession =
      delegateEnsureSession;

    const resultP = runtime.ensureSession({ sessionKey: "agent:codex:acp:binding:test" } as never);
    const expectP = expect(resultP).rejects.toThrow("ACP ensureSession timed out after 15s");
    await vi.advanceTimersByTimeAsync(15_000);
    await expectP;
  });

  it("closes the orphaned delegate session when it resolves after timeout", { timeout: 20_000 }, async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore);

    let resolveDelegate!: (handle: unknown) => void;
    const delegateEnsureSession = vi.fn(
      () => new Promise<unknown>((resolve) => { resolveDelegate = resolve; }),
    );
    (runtime as unknown as { delegate: { ensureSession: typeof delegateEnsureSession } }).delegate.ensureSession =
      delegateEnsureSession;

    const closeSpy = vi.spyOn(delegate, "close").mockResolvedValue(undefined);

    const resultP = runtime.ensureSession({ sessionKey: "agent:codex:acp:binding:test" } as never);
    const expectP = expect(resultP).rejects.toThrow("ACP ensureSession timed out after 15s");
    await vi.advanceTimersByTimeAsync(15_000);
    await expectP;

    // Simulate the delegate resolving after the timeout
    const lateHandle = { sessionKey: "agent:codex:acp:binding:test", backend: "acpx", runtimeSessionName: "late" };
    resolveDelegate(lateHandle);
    await vi.advanceTimersByTimeAsync(0);

    expect(closeSpy).toHaveBeenCalledWith({
      handle: lateHandle,
      reason: "timeout",
      discardPersistentState: false,
    });
  });

  it("clears the timer and returns the result when the delegate resolves in time", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const runtime = new AcpxRuntime({
      cwd: "/tmp",
      sessionStore: baseStore,
      agentRegistry: { resolve: () => "codex", list: () => ["codex"] },
      permissionMode: "approve-reads",
    });

    const fakeHandle = { sessionKey: "agent:codex:acp:binding:test" } as never;
    const delegateEnsureSession = vi.fn(async () => fakeHandle);
    (runtime as unknown as { delegate: { ensureSession: typeof delegateEnsureSession } }).delegate.ensureSession =
      delegateEnsureSession;

    const result = await runtime.ensureSession({ sessionKey: "agent:codex:acp:binding:test" } as never);
    expect(result).toBe(fakeHandle);
  });

  it("clears the timer and propagates the error when the delegate rejects in time", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const runtime = new AcpxRuntime({
      cwd: "/tmp",
      sessionStore: baseStore,
      agentRegistry: { resolve: () => "codex", list: () => ["codex"] },
      permissionMode: "approve-reads",
    });

    const delegateEnsureSession = vi.fn(async () => {
      throw new Error("delegate error");
    });
    (runtime as unknown as { delegate: { ensureSession: typeof delegateEnsureSession } }).delegate.ensureSession =
      delegateEnsureSession;

    await expect(
      runtime.ensureSession({ sessionKey: "agent:codex:acp:binding:test" } as never),
    ).rejects.toThrow("delegate error");
  });
});
