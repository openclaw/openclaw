import type { WorkboardChange } from "@openclaw/workboard-contract";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkboardChangeEventService } from "./change-events.js";

afterEach(() => vi.useRealTimers());

describe("createWorkboardChangeEventService", () => {
  it("keeps repeated starts on one change subscription without a freshness timer", async () => {
    vi.useFakeTimers();
    const listeners = new Set<(change: WorkboardChange) => void>();
    const unsubscribe = vi.fn((listener: (change: WorkboardChange) => void) => {
      listeners.delete(listener);
    });
    const subscribeChanges = vi.fn((listener: (change: WorkboardChange) => void) => {
      listeners.add(listener);
      return () => unsubscribe(listener);
    });
    const announceChangeEpoch = vi.fn();
    const store = {
      ready: vi.fn(async () => {}),
      subscribeChanges,
      announceChangeEpoch,
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
    expect(emit).toHaveBeenCalledExactlyOnceWith(
      "changed",
      { epoch: "epoch-a", revision: 1 },
      { scope: "operator.read" },
    );
    expect(vi.getTimerCount()).toBe(0);

    await service.stop?.(context);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
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
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      firstReady.resolve();
      await service.stop();
    }
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
