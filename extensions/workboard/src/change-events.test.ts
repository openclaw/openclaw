import type { WorkboardChange } from "@openclaw/workboard-contract";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkboardChangeEventService } from "./change-events.js";
import type { WorkboardStore } from "./store.js";

afterEach(() => vi.useRealTimers());

describe("createWorkboardChangeEventService", () => {
  it.each([false, true])(
    "does not restart event producers after stop cancels pending startup (failed: %s)",
    async (failed) => {
      vi.useFakeTimers();
      const ready = createDeferred<void>();
      const subscribeChanges = vi.fn(() => vi.fn());
      const store = {
        reconcileArtifactRetention: vi.fn(() => ready.promise),
        subscribeChanges,
        announceChangeEpoch: vi.fn(),
        reconcileExternalChanges: vi.fn(),
      } as unknown as WorkboardStore;
      const service = createWorkboardChangeEventService(store);
      const context = {
        config: {},
        stateDir: "/tmp/workboard-start-stop-test",
        gatewayEvents: { emit: vi.fn(), onSessionsChanged: () => () => undefined },
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      } satisfies Parameters<typeof service.start>[0];
      const starting = service.start(context);
      service.stop();
      if (failed) {
        ready.reject(new Error("release unavailable"));
      } else {
        ready.resolve();
      }
      await expect(starting).resolves.toBeUndefined();
      expect(subscribeChanges).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("keeps repeated starts on one change subscription and reconciliation timer", async () => {
    vi.useFakeTimers();
    const listeners = new Set<(change: WorkboardChange) => void>();
    const unsubscribe = vi.fn((listener: (change: WorkboardChange) => void) => {
      listeners.delete(listener);
    });
    const reconcileExternalChanges = vi.fn();
    const subscribeChanges = vi.fn((listener: (change: WorkboardChange) => void) => {
      listeners.add(listener);
      return () => unsubscribe(listener);
    });
    const announceChangeEpoch = vi.fn();
    const reconcileArtifactRetention = vi.fn();
    const store = {
      subscribeChanges,
      announceChangeEpoch,
      reconcileExternalChanges,
      reconcileArtifactRetention,
    } as unknown as WorkboardStore;
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
    expect(reconcileArtifactRetention).toHaveBeenCalledOnce();
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
    const reconcileExternalChanges = vi.fn();
    const reconcileArtifactRetention = vi.fn();
    const store = {
      subscribeChanges: vi.fn((next) => {
        listener = next;
        return unsubscribe;
      }),
      announceChangeEpoch: vi.fn(() => listener?.({ epoch: "epoch-a", revision: 1 })),
      reconcileExternalChanges,
      reconcileArtifactRetention,
    } as unknown as WorkboardStore;
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
    expect(reconcileArtifactRetention).toHaveBeenCalledOnce();
    await service.stop?.(context);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reconcileExternalChanges).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs external reconciliation failures without stopping the service", async () => {
    vi.useFakeTimers();
    const reconcileExternalChanges = vi.fn(() => {
      throw new Error("database unavailable");
    });
    const store = {
      subscribeChanges: vi.fn(() => vi.fn()),
      announceChangeEpoch: vi.fn(),
      reconcileExternalChanges,
      reconcileArtifactRetention: vi.fn(),
    } as unknown as WorkboardStore;
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

  it.each([false, true])(
    "keeps change events and retries after startup retention fails (gateway events: %s)",
    async (withGatewayEvents) => {
      vi.useFakeTimers();
      const reconcileArtifactRetention = vi
        .fn()
        .mockRejectedValueOnce(new Error("release unavailable during startup"))
        .mockRejectedValueOnce(new Error("release unavailable during retry"))
        .mockResolvedValue(undefined);
      let listener: ((change: WorkboardChange) => void) | undefined;
      const unsubscribe = vi.fn();
      const subscribeChanges = vi.fn((next: (change: WorkboardChange) => void) => {
        listener = next;
        return unsubscribe;
      });
      const announceChangeEpoch = vi.fn(() => listener?.({ epoch: "epoch-a", revision: 1 }));
      const reconcileExternalChanges = vi.fn();
      const store = {
        subscribeChanges,
        announceChangeEpoch,
        reconcileExternalChanges,
        reconcileArtifactRetention,
      } as unknown as WorkboardStore;
      const service = createWorkboardChangeEventService(store);
      const warn = vi.fn();
      const emit = vi.fn();
      const context = {
        config: {},
        stateDir: "/tmp/workboard-retention-retry-test",
        ...(withGatewayEvents
          ? { gatewayEvents: { emit, onSessionsChanged: () => () => undefined } }
          : {}),
        logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
      } satisfies Parameters<typeof service.start>[0];
      await expect(service.start(context)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("release unavailable during startup"),
      );
      if (withGatewayEvents) {
        expect(subscribeChanges).toHaveBeenCalledOnce();
        expect(announceChangeEpoch).toHaveBeenCalledOnce();
        listener?.({ epoch: "epoch-a", revision: 2 });
        expect(emit.mock.calls).toEqual([
          ["changed", { epoch: "epoch-a", revision: 1 }, { scope: "operator.read" }],
          ["changed", { epoch: "epoch-a", revision: 2 }, { scope: "operator.read" }],
        ]);
      } else {
        expect(subscribeChanges).not.toHaveBeenCalled();
      }
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconcileExternalChanges).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("release unavailable during retry"),
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconcileArtifactRetention).toHaveBeenCalledTimes(3);
      await service.stop?.(context);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconcileArtifactRetention).toHaveBeenCalledTimes(3);
      expect(unsubscribe).toHaveBeenCalledTimes(withGatewayEvents ? 1 : 0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
