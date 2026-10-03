import type { WorkboardChange } from "@openclaw/workboard-contract";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkboardChangeEventService } from "./change-events.js";

afterEach(() => vi.useRealTimers());

describe("createWorkboardChangeEventService", () => {
  it("keeps repeated starts on one change subscription and reconciliation timer", async () => {
    vi.useFakeTimers();
    const listeners = new Set<(change: WorkboardChange) => void>();
    const unsubscribe = vi.fn((listener: (change: WorkboardChange) => void) => {
      listeners.delete(listener);
    });
    const reconcileExternalChanges = vi.fn(async () => false);
    const subscribeChanges = vi.fn((listener: (change: WorkboardChange) => void) => {
      listeners.add(listener);
      return () => unsubscribe(listener);
    });
    const announceChangeEpoch = vi.fn();
    const store = {
      ready: vi.fn(async () => {}),
      subscribeChanges,
      announceChangeEpoch,
      reconcileExternalChanges,
    } satisfies Parameters<typeof createWorkboardChangeEventService>[0];
    const emit = vi.fn();
    const service = createWorkboardChangeEventService(store);
    const context = {
      config: {},
      stateDir: "/tmp/workboard-change-events-test",
      gatewayEvents: { emit, onSessionsChanged: () => () => undefined },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } satisfies Parameters<typeof service.start>[0];

    for (let attempt = 0; attempt < 25; attempt += 1) {
      await service.start(context);
    }

    expect(subscribeChanges).toHaveBeenCalledOnce();
    expect(announceChangeEpoch).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(1);

    for (const listener of listeners) {
      listener({ epoch: "epoch-a", revision: 1 });
    }
    expect(emit).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(reconcileExternalChanges).toHaveBeenCalledTimes(5);

    await service.stop?.(context);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reconcileExternalChanges).toHaveBeenCalledTimes(5);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("announces its epoch, forwards changes, and reconciles external commits", async () => {
    vi.useFakeTimers();
    let listener: ((change: WorkboardChange) => void) | undefined;
    const unsubscribe = vi.fn();
    const reconcileExternalChanges = vi.fn(async () => false);
    const store = {
      ready: vi.fn(async () => {}),
      subscribeChanges: vi.fn((next) => {
        listener = next;
        return unsubscribe;
      }),
      announceChangeEpoch: vi.fn(() => listener?.({ epoch: "epoch-a", revision: 1 })),
      reconcileExternalChanges,
    } satisfies Parameters<typeof createWorkboardChangeEventService>[0];
    const emit = vi.fn();
    const warn = vi.fn();
    const service = createWorkboardChangeEventService(store);
    const context = {
      config: {},
      stateDir: "/tmp/workboard-change-events-test",
      gatewayEvents: { emit, onSessionsChanged: () => () => undefined },
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    } satisfies Parameters<typeof service.start>[0];

    await service.start(context);
    listener?.({ epoch: "epoch-a", revision: 2 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(emit.mock.calls).toEqual([
      ["changed", { epoch: "epoch-a", revision: 1 }, { scope: "operator.read" }],
      ["changed", { epoch: "epoch-a", revision: 2 }, { scope: "operator.read" }],
    ]);
    expect(reconcileExternalChanges).toHaveBeenCalledOnce();
    await service.stop?.(context);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reconcileExternalChanges).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs external reconciliation failures without stopping the service", async () => {
    vi.useFakeTimers();
    const reconcileExternalChanges = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const store = {
      ready: vi.fn(async () => {}),
      subscribeChanges: vi.fn(() => vi.fn()),
      announceChangeEpoch: vi.fn(),
      reconcileExternalChanges,
    } satisfies Parameters<typeof createWorkboardChangeEventService>[0];
    const warn = vi.fn();
    const service = createWorkboardChangeEventService(store);
    const context = {
      config: {},
      stateDir: "/tmp/workboard-change-events-test",
      gatewayEvents: { emit: vi.fn(), onSessionsChanged: () => () => undefined },
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    } satisfies Parameters<typeof service.start>[0];

    await service.start(context);
    await vi.advanceTimersByTimeAsync(2000);
    expect(reconcileExternalChanges).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
    await service.stop?.(context);
  });

  it("starts the new generation after stopping an unfinished initialization", async () => {
    vi.useFakeTimers();
    const firstReady = createDeferred<void>();
    const ready = vi.fn(async () => {});
    ready.mockImplementationOnce(() => firstReady.promise);
    const unsubscribe = vi.fn();
    const store = {
      ready,
      subscribeChanges: vi.fn(() => unsubscribe),
      announceChangeEpoch: vi.fn(),
      reconcileExternalChanges: vi.fn(async () => false),
    } satisfies Parameters<typeof createWorkboardChangeEventService>[0];
    const service = createWorkboardChangeEventService(store);
    const context = {
      config: {},
      stateDir: "/unused-workboard-change-events",
      gatewayEvents: { emit: vi.fn(), onSessionsChanged: () => () => {} },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } satisfies Parameters<typeof service.start>[0];

    const starting = service.start(context);
    const stopping = service.stop();
    const restarted = service.start(context);
    try {
      expect(store.subscribeChanges).not.toHaveBeenCalled();
      firstReady.resolve();
      await Promise.all([starting, stopping, restarted]);
      expect(store.subscribeChanges).toHaveBeenCalledOnce();
      expect(store.announceChangeEpoch).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1000);
      expect(store.reconcileExternalChanges).toHaveBeenCalledOnce();
    } finally {
      firstReady.resolve();
      await service.stop();
    }
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps slow polls nonoverlapping and drains a rejected poll on stop", async () => {
    vi.useFakeTimers();
    const poll = createDeferred<boolean>();
    const unsubscribe = vi.fn();
    const store = {
      ready: vi.fn(async () => {}),
      subscribeChanges: vi.fn(() => unsubscribe),
      announceChangeEpoch: vi.fn(),
      reconcileExternalChanges: vi.fn(() => poll.promise),
    } satisfies Parameters<typeof createWorkboardChangeEventService>[0];
    const service = createWorkboardChangeEventService(store);
    const warn = vi.fn();
    const context = {
      config: {},
      stateDir: "/unused-workboard-change-events",
      gatewayEvents: { emit: vi.fn(), onSessionsChanged: () => () => {} },
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    } satisfies Parameters<typeof service.start>[0];
    await service.start(context);
    try {
      await vi.advanceTimersByTimeAsync(5000);
      expect(store.reconcileExternalChanges).toHaveBeenCalledOnce();
      const drained = vi.fn();
      const stopping = service.stop().then(drained);
      await vi.advanceTimersByTimeAsync(5000);
      expect(drained).not.toHaveBeenCalled();
      expect(store.reconcileExternalChanges).toHaveBeenCalledOnce();
      poll.reject(new Error("controlled poll failure"));
      await stopping;
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        "workboard external change check failed: Error: controlled poll failure",
      );
      expect(drained).toHaveBeenCalledOnce();
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      poll.resolve(false);
      await service.stop();
    }
  });
});
