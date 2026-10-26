import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMatrixMonitorIndexTestHarness } from "./index.test-helpers.js";

const hoisted = getMatrixMonitorIndexTestHarness();
import { monitorMatrixProvider } from "./index.js";

const setStatus = vi.fn<(snapshot: ChannelAccountSnapshot) => void>();
const monitors: Array<{ controller: AbortController; promise: Promise<void> }> = [];
const releaseHolds: Array<() => void> = [];

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.callOrder.length = 0;
  hoisted.state.leaseAbortController = new AbortController();
  hoisted.state.monitorRetirement = null;
  hoisted.state.monitorRetirementPromise = null;
  hoisted.state.startClientError = null;
  hoisted.client.removeAllListeners();
  hoisted.releaseSharedClientInstance.mockReset().mockImplementation(hoisted.finalReleaseImpl);
  hoisted.runMatrixStartupMaintenance.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  for (const release of releaseHolds.splice(0)) {
    release();
  }
  for (const monitor of monitors) {
    monitor.controller.abort();
  }
  await Promise.allSettled(monitors.splice(0).map((monitor) => monitor.promise));
  vi.useRealTimers();
});

async function startMonitor(onMaintenance?: () => void) {
  const ready = createDeferred<void>();
  hoisted.runMatrixStartupMaintenance.mockImplementationOnce(async () => {
    onMaintenance?.();
    ready.resolve();
  });
  const controller = new AbortController();
  const promise = monitorMatrixProvider({ abortSignal: controller.signal, setStatus });
  const monitor = { controller, promise };
  monitors.push(monitor);
  await ready.promise;
  return monitor;
}

function holdClientRelease() {
  const started = createDeferred<void>();
  const proceed = createDeferred<void>();
  hoisted.releaseSharedClientInstance.mockImplementation(async () => {
    started.resolve();
    await proceed.promise;
    await hoisted.finalReleaseImpl();
  });
  const release = () => proceed.resolve();
  releaseHolds.push(release);
  return { started: started.promise, release };
}

function expectLastStatus(fields: Partial<ChannelAccountSnapshot>) {
  expect(setStatus).toHaveBeenLastCalledWith(expect.objectContaining(fields));
}

function expectFatal(message: string) {
  expectLastStatus({ accountId: "default", healthState: "error", lastError: message });
}

describe("Matrix monitor sync lifecycle", () => {
  it.each(["during startup", "after startup"])(
    "contains missing-key-shaped fatal sync errors %s",
    async (phase) => {
      const error = new Error(
        "Error decrypting event (id=$event type=m.room.encrypted): DecryptionError[msg: The sender's device has not sent us the keys for this message.]",
      );
      const emitError = () => hoisted.client.emit("sync.unexpected_error", error);
      const monitor = await startMonitor(phase === "during startup" ? emitError : undefined);
      if (phase === "after startup") {
        emitError();
      }

      await expect(monitor.promise).rejects.toThrow(error.message);
      expectFatal(error.message);
      expect(hoisted.releaseSharedClientInstance).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "persist" }),
      );
      expect(hoisted.client.listenerCount("sync.unexpected_error")).toBe(0);
    },
  );

  it("fails the channel task for an unexpected STOPPED sync", async () => {
    const monitor = await startMonitor();
    hoisted.client.emit("sync.state", "STOPPED", "SYNCING", undefined);

    await expect(monitor.promise).rejects.toThrow("Matrix sync stopped unexpectedly");
    expectFatal("Matrix sync stopped unexpectedly");
  });

  it.each(["STOPPED", "unexpected_error", "ERROR"])(
    "ignores %s shutdown noise before listeners detach",
    async (event) => {
      const retirement = holdClientRelease();
      const monitor = await startMonitor();
      monitor.controller.abort();
      await retirement.started;

      expect(hoisted.client.listenerCount("sync.state")).toBeGreaterThan(0);
      expect(hoisted.client.listenerCount("sync.unexpected_error")).toBeGreaterThan(0);
      if (event === "unexpected_error") {
        hoisted.client.emit("sync.unexpected_error", new Error("shutdown noise"));
      } else {
        hoisted.client.emit(
          "sync.state",
          event,
          "SYNCING",
          event === "ERROR" ? new Error("shutdown noise") : undefined,
        );
      }
      expect(setStatus.mock.calls.some(([status]) => status.healthState === "error")).toBe(false);

      retirement.release();
      await expect(monitor.promise).resolves.toBeUndefined();
      expectLastStatus({ accountId: "default", healthState: "stopped", lastError: null });
      expect(hoisted.client.listenerCount("sync.state")).toBe(0);
      expect(hoisted.client.listenerCount("sync.unexpected_error")).toBe(0);
    },
  );

  it("only refreshes transport liveness for successful sync responses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T16:21:00.000Z"));
    const monitor = await startMonitor();
    setStatus.mockClear();

    hoisted.client.emit("sync.state", "PREPARED", null, undefined);
    expect(setStatus.mock.lastCall?.[0].lastTransportActivityAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    hoisted.client.emit("sync.state", "SYNCING", "PREPARED", undefined);
    const syncAt = Date.now();
    expectLastStatus({ lastTransportActivityAt: syncAt });
    await vi.advanceTimersByTimeAsync(3_000);
    hoisted.client.emit("sync.state", "CATCHUP", "SYNCING", undefined);
    expectLastStatus({ lastTransportActivityAt: syncAt });

    monitor.controller.abort();
    await monitor.promise;
  });

  it.each(["shutdown STOPPED", "late RECONNECTING"])(
    "preserves fatal telemetry through %s",
    async (transition) => {
      const retirement = holdClientRelease();
      const monitor = await startMonitor();
      const rejected = expect(monitor.promise).rejects.toThrow("sync exploded");
      hoisted.client.emit("sync.unexpected_error", new Error("sync exploded"));
      if (transition === "late RECONNECTING") {
        hoisted.client.emit("sync.state", "RECONNECTING", "SYNCING", new Error("late reconnect"));
      }
      expectFatal("sync exploded");
      await retirement.started;
      if (transition === "shutdown STOPPED") {
        monitor.controller.abort();
        expect(hoisted.client.listenerCount("sync.state")).toBeGreaterThan(0);
        hoisted.client.emit("sync.state", "STOPPED", "SYNCING", undefined);
      }
      expectFatal("sync exploded");

      retirement.release();
      await rejected;
      expectFatal("sync exploded");
    },
  );
});
