import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixConfig, MatrixStreamingMode } from "../../types.js";
import {
  getMatrixMonitorIndexTestHarness,
  type DirectRoomTrackerOptions,
} from "./index.test-helpers.js";
import type { MatrixRoomInfo } from "./room-info.js";

const hoisted = getMatrixMonitorIndexTestHarness();
import { monitorMatrixProvider } from "./index.js";

describe("monitorMatrixProvider", () => {
  async function flushUntil(predicate: () => boolean, message: string): Promise<void> {
    for (let i = 0; i < 20; i++) {
      if (predicate()) {
        return;
      }
      await Promise.resolve();
    }
    throw new Error(message);
  }

  async function waitForCallOrderEntry(entry: string): Promise<void> {
    await flushUntil(
      () => hoisted.callOrder.includes(entry),
      `expected call order to include ${entry}`,
    );
  }

  async function startMonitorAndAbortAfterStartup(): Promise<void> {
    const { abortController, monitorPromise } = await startMonitor();
    abortController.abort();
    await monitorPromise;
  }

  async function startMonitor(waitForStartup = true) {
    const abortController = new AbortController();
    const monitorPromise = monitorMatrixProvider({
      abortSignal: abortController.signal,
      setStatus: hoisted.setStatus,
    });
    if (waitForStartup) {
      await waitForCallOrderEntry("start-client");
    }
    return { abortController, monitorPromise };
  }

  function registeredRoomMessageHandler() {
    const handler = hoisted.callbacks.roomMessage;
    if (!handler) {
      throw new Error("expected room message handler to be registered");
    }
    return handler;
  }

  function expectRelease(mode: "persist" | "stop" = "persist") {
    expect(hoisted.releaseSharedClientInstance).toHaveBeenCalledWith(
      expect.objectContaining({ mode }),
    );
  }

  function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0, argIndex = 0): unknown {
    const call = mock.mock.calls.at(index);
    if (!call) {
      throw new Error(`expected mock call ${index}`);
    }
    return call[argIndex];
  }

  async function directRoomCallback<Key extends keyof DirectRoomTrackerOptions>(key: Key) {
    await startMonitorAndAbortAfterStartup();
    const callback = hoisted.createDirectRoomTracker.mock.calls[0]?.[1]?.[key];
    if (!callback) {
      throw new Error(`expected direct room callback: ${key}`);
    }
    return callback;
  }

  function mockRoomInfo(overrides: Partial<MatrixRoomInfo> = {}) {
    hoisted.getRoomInfo.mockResolvedValueOnce({
      altAliases: [],
      nameResolved: true,
      aliasesResolved: true,
      ...overrides,
    });
  }

  function expectStatusCallFields(fields: Record<string, unknown>) {
    expect(hoisted.setStatus).toHaveBeenCalledWith(expect.objectContaining(fields));
  }

  function expectCallOrder(...entries: string[]) {
    for (let i = 1; i < entries.length; i++) {
      expect(hoisted.callOrder.indexOf(entries[i - 1])).toBeLessThan(
        hoisted.callOrder.indexOf(entries[i]),
      );
    }
  }

  function holdTask(start: string, done: string) {
    const gate = createDeferred<void>();
    hoisted.callOrder.push(start);
    return {
      promise: gate.promise,
      finish() {
        hoisted.callOrder.push(done);
        gate.resolve();
      },
    };
  }

  function untilAbort(signal?: AbortSignal): Promise<never> {
    return new Promise((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => {
          reject(Object.assign(new Error("Matrix startup aborted"), { name: "AbortError" }));
        },
        { once: true },
      );
    });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    hoisted.callOrder.length = 0;
    hoisted.state.leaseAbortController = new AbortController();
    hoisted.state.monitorRetirement = null;
    hoisted.state.monitorRetirementPromise = null;
    hoisted.accountConfig.dm = {};
    delete hoisted.accountConfig.streaming;
    delete hoisted.accountConfig.rooms;
    hoisted.callbacks.roomMessage = null;
    hoisted.callbacks.healthySync = undefined;
    hoisted.client.removeAllListeners();
  });

  it.each([
    [{ mode: "quiet" }, "quiet", true],
    [{ mode: "progress" }, "progress", false],
    [{ mode: "progress", progress: { toolProgress: true } }, "progress", true],
    [{ mode: "quiet", preview: { toolProgress: false } }, "quiet", false],
  ] satisfies Array<[MatrixConfig["streaming"], MatrixStreamingMode, boolean]>)(
    "resolves streaming=%j to mode=%s and toolProgress=%s",
    async (streaming, expectedMode, expectedPreviewToolProgressEnabled) => {
      hoisted.accountConfig.streaming = streaming;

      await startMonitorAndAbortAfterStartup();

      expect(mockCallArg(hoisted.createMatrixRoomMessageHandler)).toMatchObject({
        streaming: expectedMode,
        previewToolProgressEnabled: expectedPreviewToolProgressEnabled,
      });
    },
  );

  it("returns immediately when the abort signal is already canceled", async () => {
    const abortController = new AbortController();
    abortController.abort();

    await monitorMatrixProvider({ abortSignal: abortController.signal });

    expect(hoisted.callOrder).toStrictEqual([]);
    expect(hoisted.createMatrixRoomMessageHandler).not.toHaveBeenCalled();
    expect(hoisted.acquireSharedMatrixClient).not.toHaveBeenCalled();
  });

  it("re-arms the healthy-sync milestone across reconnect transitions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T16:21:00.000Z"));
    const abortController = new AbortController();
    try {
      const monitorPromise = monitorMatrixProvider({
        abortSignal: abortController.signal,
        setStatus: hoisted.setStatus,
      });

      await waitForCallOrderEntry("start-client");

      const getHealthySyncSinceMs = hoisted.callbacks.healthySync;
      if (!getHealthySyncSinceMs) {
        throw new Error("expected healthy sync getter to be registered");
      }

      expect(getHealthySyncSinceMs()).toBeUndefined();

      const startedAt = Date.now();
      for (const [delay, state, previous, healthyOffset] of [
        [0, "SYNCING", "RECONNECTING", 0],
        [3_000, "CATCHUP", "SYNCING", 0],
        [2_000, "PREPARED", "CATCHUP", 0],
        [5_000, "RECONNECTING", "SYNCING", undefined],
        [7_000, "SYNCING", "RECONNECTING", 17_000],
      ] as const) {
        await vi.advanceTimersByTimeAsync(delay);
        hoisted.client.emit(
          "sync.state",
          state,
          previous,
          state === "RECONNECTING" ? new Error("network flap") : undefined,
        );
        expect(getHealthySyncSinceMs()).toBe(
          healthyOffset === undefined ? undefined : startedAt + healthyOffset,
        );
      }

      abortController.abort();
      await expect(monitorPromise).resolves.toBeUndefined();

      hoisted.client.emit("sync.state", "RECONNECTING", "SYNCING", new Error("late noise"));
      expect(getHealthySyncSinceMs()).toBe(startedAt + 17_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("contains room-message handler rejections inside monitor task tracking", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };

    hoisted.createMatrixRoomMessageHandler.mockReturnValue(
      vi.fn(async () => {
        throw new Error("room handler exploded");
      }),
    );

    process.on("unhandledRejection", onUnhandled);
    try {
      const { abortController, monitorPromise } = await startMonitor();

      const onRoomMessage = registeredRoomMessageHandler();

      await onRoomMessage("!room:example.org", { event_id: "$event" });
      await Promise.resolve();

      expect(unhandled).toHaveLength(0);
      expect(mockCallArg(hoisted.logger.warn, 0, 0)).toBe("matrix background task failed");
      expect(mockCallArg(hoisted.logger.warn, 0, 1)).toMatchObject({
        task: "test room message",
        error: "Error: room handler exploded",
      });

      abortController.abort();
      await monitorPromise;
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("fails the channel task when Matrix sync emits an unexpected fatal error", async () => {
    const { monitorPromise } = await startMonitor();

    hoisted.client.emit("sync.unexpected_error", new Error("sync exploded"));

    await expect(monitorPromise).rejects.toThrow("sync exploded");
    expectRelease();
    expectStatusCallFields({
      accountId: "default",
      connected: false,
      healthState: "error",
      lastError: "sync exploded",
    });
  });

  it("releases the prepared client when startup fails before later resources exist", async () => {
    hoisted.createMatrixInboundEventDeduper.mockImplementation(() => {
      throw new Error("deduper failed");
    });

    await expect(
      monitorMatrixProvider({
        setStatus: hoisted.setStatus,
      }),
    ).rejects.toThrow("deduper failed");

    expectRelease();
    expect(hoisted.setStatus.mock.calls.at(-1)?.[0]).toMatchObject({
      accountId: "default",
      connected: false,
      healthState: "error",
      lastError: "deduper failed",
    });
  });

  it.each(["startup", "maintenance"] as const)(
    "aborts stalled %s without persisting",
    async (phase) => {
      const handler = vi.fn(async () => {});
      hoisted.createMatrixRoomMessageHandler.mockReturnValue(handler);
      if (phase === "startup") {
        hoisted.resolveSharedMatrixClient.mockImplementation(async (signal?: AbortSignal) => {
          hoisted.callOrder.push("start-client");
          return await untilAbort(signal);
        });
      } else {
        hoisted.runMatrixStartupMaintenance.mockImplementation(
          async ({ abortSignal }) => await untilAbort(abortSignal),
        );
      }
      const { abortController, monitorPromise } = await startMonitor(phase === "startup");
      if (phase === "maintenance") {
        await flushUntil(
          () => hoisted.runMatrixStartupMaintenance.mock.calls.length === 1,
          "expected startup maintenance to run",
        );
      }
      abortController.abort();

      await expect(monitorPromise).resolves.toBeUndefined();
      expectRelease("stop");
      expect(hoisted.client.drainPendingDecryptions).not.toHaveBeenCalled();
      await hoisted.callbacks.roomMessage?.("!room:example.org", { event_id: "$late" });
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("disposes resources installed after forced retirement wins setup", async () => {
    const stopLateManager = vi.fn();
    const managerReady = createDeferred<{ accountId: string; stop: typeof stopLateManager }>();
    hoisted.createThreadBindingManager.mockImplementation(async () => {
      hoisted.callOrder.push("create-manager");
      return await managerReady.promise;
    });

    const monitorPromise = monitorMatrixProvider();
    await waitForCallOrderEntry("create-manager");

    await hoisted.runRegisteredMonitorRetirement();
    expect(hoisted.disposeAutoJoin).toHaveBeenCalledTimes(1);
    expect(hoisted.client.listenerCount("sync.state")).toBe(0);
    expect(hoisted.registerMatrixMonitorEvents).not.toHaveBeenCalled();

    managerReady.resolve({
      accountId: "default",
      stop: stopLateManager,
    });
    await expect(monitorPromise).resolves.toBeUndefined();

    expect(stopLateManager).toHaveBeenCalledTimes(1);
    expect(hoisted.resolveSharedMatrixClient).not.toHaveBeenCalled();
    expect(hoisted.registerMatrixMonitorEvents).not.toHaveBeenCalled();
    expectRelease("stop");
    expect(hoisted.disposeAutoJoin).toHaveBeenCalledTimes(1);
    expect(hoisted.client.listenerCount("sync.state")).toBe(0);
  });

  it("registers Matrix thread bindings before starting the client", async () => {
    await startMonitorAndAbortAfterStartup();

    expect(hoisted.callOrder).toEqual([
      "prepare-client",
      "create-manager",
      "register-events",
      "start-client",
      "dispose-auto-join",
      "dispose-monitor-events",
    ]);
    expect(hoisted.acquireSharedMatrixClient).toHaveBeenCalledWith(
      expect.objectContaining({ startClient: false }),
    );
    expect(hoisted.stopThreadBindingManager).toHaveBeenCalledTimes(1);
  });

  it("starts monitoring without waiting for backfill but joins it during retirement", async () => {
    const backfill = createDeferred<undefined>();
    hoisted.backfillMatrixAuthDeviceIdAfterStartup.mockReturnValue(backfill.promise);
    const { abortController, monitorPromise } = await startMonitor();
    expect(hoisted.backfillMatrixAuthDeviceIdAfterStartup).toHaveBeenCalledTimes(1);
    const [backfillParams] = hoisted.backfillMatrixAuthDeviceIdAfterStartup.mock.calls[0]!;
    expect(backfillParams.abortSignal).not.toBe(abortController.signal);
    expect(backfillParams.abortSignal?.aborted).toBe(false);

    let retired = false;
    void monitorPromise.then(() => {
      retired = true;
    });
    abortController.abort();
    expect(backfillParams.abortSignal?.aborted).toBe(true);
    await setImmediate();
    expect(retired).toBe(false);
    expect(hoisted.stopThreadBindingManager).not.toHaveBeenCalled();
    backfill.resolve(undefined);
    await expect(monitorPromise).resolves.toBeUndefined();
  });

  it("terminates a fully started monitor when forced retirement aborts its lease", async () => {
    const monitorPromise = monitorMatrixProvider();
    await flushUntil(
      () =>
        hoisted.runMatrixStartupMaintenance.mock.calls.length === 1 &&
        hoisted.registerChannelRuntimeContext.mock.calls.length === 1,
      "expected monitor startup consumers to be registered",
    );

    const startSignal = hoisted.resolveSharedMatrixClient.mock.calls[0]![0]!;
    const [backfillParams] = hoisted.backfillMatrixAuthDeviceIdAfterStartup.mock.calls[0]!;
    const [runtimeContextParams] = hoisted.registerChannelRuntimeContext.mock.calls[0]!;
    const [maintenanceParams] = hoisted.runMatrixStartupMaintenance.mock.calls[0]!;
    expect(backfillParams.abortSignal?.aborted).toBe(false);
    expect(runtimeContextParams.abortSignal).toBe(startSignal);
    expect(maintenanceParams.abortSignal).toBe(startSignal);
    expect(startSignal.aborted).toBe(false);

    hoisted.state.leaseAbortController.abort();
    expect(backfillParams.abortSignal?.aborted).toBe(true);
    await hoisted.runRegisteredMonitorRetirement();
    await expect(monitorPromise).resolves.toBeUndefined();

    expect(startSignal.aborted).toBe(true);
    expect(hoisted.releaseSharedClientInstance).toHaveBeenCalledTimes(1);
    expect(hoisted.stopThreadBindingManager).toHaveBeenCalledTimes(1);
    expect(hoisted.client.listenerCount("sync.state")).toBe(0);
  });

  it("cleans up thread bindings and shared clients when startup fails", async () => {
    hoisted.state.startClientError = new Error("start failed");

    await expect(monitorMatrixProvider()).rejects.toThrow("start failed");

    expect(hoisted.stopThreadBindingManager).toHaveBeenCalledTimes(1);
    expect(hoisted.releaseSharedClientInstance).toHaveBeenCalledTimes(1);
    expectPersistRelease();
  });

  it("detaches listeners, closes admission, waits for handlers, then releases", async () => {
    const pendingHandlers = new Map<string, ReturnType<typeof holdTask>>();
    let managerStop: ReturnType<typeof holdTask> | undefined;

    hoisted.createMatrixRoomMessageHandler.mockReturnValue(
      vi.fn((_roomId: string, event: unknown) => {
        const eventId = (event as { event_id: string }).event_id;
        const task = holdTask(`handler-start:${eventId}`, `handler-done:${eventId}`);
        pendingHandlers.set(eventId, task);
        return task.promise;
      }),
    );
    hoisted.client.drainPendingDecryptions.mockImplementation(async () => {
      hoisted.callOrder.push("drain-decrypts");
    });
    hoisted.stopThreadBindingManager.mockImplementation(async () => {
      managerStop = holdTask("stop-manager", "manager-stopped");
      await managerStop.promise;
    });
    hoisted.releaseSharedClientInstance.mockImplementation(async () => {
      await hoisted.client.drainPendingDecryptions();
      await hoisted.runRegisteredMonitorRetirement();
      hoisted.callOrder.push("release-client");
    });

    const { abortController, monitorPromise } = await startMonitor();
    const onRoomMessage = registeredRoomMessageHandler();

    const roomMessagePromise = onRoomMessage("!room:example.org", { event_id: "$event" });
    abortController.abort();
    await waitForCallOrderEntry("dispose-monitor-events");
    expect(hoisted.callOrder).not.toContain("stop-manager");
    expect(hoisted.callOrder).not.toContain("release-client");

    await onRoomMessage("!room:example.org", { event_id: "$late" });
    expect(hoisted.callOrder).not.toContain("handler-start:$late");

    pendingHandlers.get("$event")?.finish();
    await roomMessagePromise;
    await waitForCallOrderEntry("stop-manager");
    expect(hoisted.callOrder).not.toContain("release-client");

    managerStop?.finish();
    await monitorPromise;

    expectCallOrder(
      "drain-decrypts",
      "dispose-auto-join",
      "handler-done:$event",
      "stop-manager",
      "manager-stopped",
      "release-client",
    );
    expectCallOrder("dispose-monitor-events", "handler-done:$event");
  });

  it("cleans up local monitor work after a retained shared-client release", async () => {
    let pendingHandler: ReturnType<typeof holdTask> | undefined;
    hoisted.createMatrixRoomMessageHandler.mockReturnValue(
      vi.fn(() => {
        pendingHandler = holdTask("handler-start", "handler-done");
        return pendingHandler.promise;
      }),
    );
    hoisted.stopThreadBindingManager.mockImplementation(() => {
      hoisted.callOrder.push("stop-manager");
    });
    hoisted.releaseSharedClientInstance.mockImplementation(async () => {
      await hoisted.runRegisteredMonitorRetirement();
      hoisted.callOrder.push("release-retained");
    });

    const { abortController, monitorPromise } = await startMonitor();
    const onRoomMessage = registeredRoomMessageHandler();

    const roomMessagePromise = onRoomMessage("!room:example.org", { event_id: "$event" });
    await waitForCallOrderEntry("handler-start");
    abortController.abort();
    await waitForCallOrderEntry("dispose-monitor-events");

    expect(hoisted.client.drainPendingDecryptions).not.toHaveBeenCalled();
    expect(hoisted.callOrder).not.toContain("release-retained");

    pendingHandler?.finish();
    await roomMessagePromise;
    await monitorPromise;

    expectCallOrder("handler-done", "stop-manager", "release-retained");
  });

  it("wires recent-invite promotion to fail closed when room metadata is unresolved", async () => {
    const promote = await directRoomCallback("canPromoteRecentInvite");
    mockRoomInfo({ nameResolved: false, aliasesResolved: false });
    await expect(promote("!room:example.org")).resolves.toBe(false);
  });

  it.each(["!room:example.org", "#ops:example.org"])(
    "uses %s config as a direct-room veto",
    async (room) => {
      hoisted.accountConfig.rooms = {
        [room]: { requireMention: true },
        "*": { requireMention: false },
      };
      const alias = room.startsWith("#");
      if (alias) {
        const { resolveMatrixTargets } = await import("../../resolve-targets.js");
        vi.mocked(resolveMatrixTargets).mockResolvedValueOnce([
          { input: room, resolved: true, id: "!room:example.org" },
        ]);
      }
      const configured = await directRoomCallback("isExplicitlyConfiguredRoom");
      if (alias) {
        mockRoomInfo({ canonicalAlias: room });
      }
      expect(await configured("!room:example.org")).toBe(true);
      if (!alias) {
        expect(await configured("!other:example.org")).toBe(false);
        expect(hoisted.getRoomInfo).not.toHaveBeenCalled();
      }
    },
  );

  it("wires recent-invite promotion to reject wildcard-configured rooms", async () => {
    hoisted.accountConfig.rooms = {
      "*": { enabled: false },
    };

    const promote = await directRoomCallback("canPromoteRecentInvite");
    mockRoomInfo();
    await expect(promote("!room:example.org")).resolves.toBe(false);
  });

  it("wires per-room unmapped strict room promotion through the room metadata gate", async () => {
    hoisted.accountConfig.dm = { sessionScope: "per-room" };

    const promote = await directRoomCallback("canPromoteUnmappedStrictRoom");
    mockRoomInfo();
    await expect(promote("!dm:example.org")).resolves.toBe(true);
    mockRoomInfo({ name: "Ops Room" });
    await expect(promote("!ops:example.org")).resolves.toBe(false);
  });

  it("treats unresolved room metadata as indeterminate for local promotion revalidation", async () => {
    const keep = await directRoomCallback("shouldKeepLocallyPromotedDirectRoom");
    mockRoomInfo({ nameResolved: false, aliasesResolved: false });
    await expect(keep("!room:example.org")).resolves.toBeUndefined();
  });
});
