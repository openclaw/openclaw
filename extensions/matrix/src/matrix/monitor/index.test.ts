import { setImmediate } from "node:timers/promises";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixConfig, MatrixStreamingMode } from "../../types.js";
import {
  getMatrixMonitorIndexTestHarness,
  type DirectRoomTrackerOptions,
} from "./index.test-helpers.js";

const hoisted = getMatrixMonitorIndexTestHarness();
import { monitorMatrixProvider } from "./index.js";
import type { MatrixRoomInfo } from "./room-info.js";

const roomInfo = (overrides: Partial<MatrixRoomInfo> = {}): MatrixRoomInfo => ({
  altAliases: [],
  nameResolved: true,
  aliasesResolved: true,
  ...overrides,
});

function rejectOnAbort<T>(signal?: AbortSignal): Promise<T> {
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
    const abortController = new AbortController();
    const monitorPromise = monitorMatrixProvider({ abortSignal: abortController.signal });
    await waitForCallOrderEntry("start-client");
    abortController.abort();
    await monitorPromise;
  }

  const registeredRoomMessageHandler = () =>
    expectDefined(hoisted.registeredOnRoomMessage, "room message handler");

  function expectPersistRelease() {
    expect(hoisted.releaseSharedClientInstance).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "persist" }),
    );
  }

  function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0, argIndex = 0): unknown {
    const call = mock.mock.calls.at(index);
    if (!call) {
      throw new Error(`expected mock call ${index}`);
    }
    return call[argIndex];
  }

  function directRoomTrackerOptions(): DirectRoomTrackerOptions {
    const opts = mockCallArg(hoisted.createDirectRoomTracker, 0, 1);
    if (!opts || typeof opts !== "object") {
      throw new Error("expected direct room tracker options");
    }
    return opts as DirectRoomTrackerOptions;
  }

  function expectStatusCallFields(fields: Record<string, unknown>) {
    expect(hoisted.setStatus).toHaveBeenCalledWith(expect.objectContaining(fields));
  }

  function expectLastStatusFields(fields: Record<string, unknown>) {
    expect(hoisted.setStatus).toHaveBeenLastCalledWith(expect.objectContaining(fields));
  }

  beforeEach(() => {
    hoisted.callOrder.length = 0;
    hoisted.state.leaseAbortController = new AbortController();
    hoisted.state.monitorRetirement = null;
    hoisted.state.monitorRetirementPromise = null;
    hoisted.state.startClientError = null;
    hoisted.accountConfig.dm = {};
    delete (hoisted.accountConfig as { streaming?: unknown }).streaming;
    delete (hoisted.accountConfig as { rooms?: Record<string, unknown> }).rooms;
    hoisted.acquireSharedMatrixClient
      .mockReset()
      .mockImplementation(hoisted.acquireSharedMatrixClientImpl);
    hoisted.releaseSharedClientInstance.mockReset().mockImplementation(hoisted.finalReleaseImpl);
    hoisted.registerMonitorRetirement.mockClear();
    hoisted.resolveSharedMatrixClient
      .mockReset()
      .mockImplementation(hoisted.resolveSharedMatrixClientImpl);
    hoisted.createDirectRoomTracker.mockReset().mockReturnValue({
      isDirectMessage: vi.fn(async () => false),
    });
    hoisted.createThreadBindingManager.mockReset().mockImplementation(async () => {
      hoisted.callOrder.push("create-manager");
      return {
        accountId: "default",
        stop: hoisted.stopThreadBindingManager,
      };
    });
    hoisted.getRoomInfo.mockReset().mockResolvedValue(roomInfo());
    hoisted.getMemberDisplayName.mockReset().mockResolvedValue("Bot");
    hoisted.registeredOnRoomMessage = null;
    hoisted.registeredHealthySyncGetter = undefined;
    hoisted.stopThreadBindingManager.mockReset().mockResolvedValue(undefined);
    hoisted.client.removeAllListeners();
    hoisted.client.bindSyncIngress.mockClear();
    hoisted.ingress.start.mockClear();
    hoisted.ingress.stop.mockClear();
    hoisted.client.drainPendingDecryptions.mockReset().mockResolvedValue(undefined);
    hoisted.createMatrixIngressMonitor.mockClear();
    hoisted.backfillMatrixAuthDeviceIdAfterStartup.mockReset().mockResolvedValue(undefined);
    hoisted.registerChannelRuntimeContext.mockReset();
    hoisted.runMatrixStartupMaintenance.mockReset().mockResolvedValue(undefined);
    hoisted.createMatrixRoomMessageHandler.mockReset().mockReturnValue(vi.fn());
    hoisted.disposeAutoJoin.mockClear();
    hoisted.disposeMonitorEvents.mockClear();
    hoisted.registerMatrixAutoJoin.mockClear();
    hoisted.registerMatrixMonitorEvents.mockClear();
    hoisted.setStatus.mockReset();
    Object.values(hoisted.logger).forEach((mock) => mock.mockReset());
  });

  it.each([
    [{ mode: "quiet" }, "quiet", true],
    [{ mode: "progress" }, "progress", false],
    [{ mode: "progress", progress: { toolProgress: true } }, "progress", true],
    [{ mode: "quiet", preview: { toolProgress: false } }, "quiet", false],
  ] satisfies Array<[MatrixConfig["streaming"], MatrixStreamingMode, boolean]>)(
    "resolves streaming=%j to mode=%s and toolProgress=%s",
    async (streaming, expectedMode, expectedPreviewToolProgressEnabled) => {
      (hoisted.accountConfig as { streaming?: unknown }).streaming = streaming;

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

      const getHealthySyncSinceMs = hoisted.registeredHealthySyncGetter;
      if (!getHealthySyncSinceMs) {
        throw new Error("expected healthy sync getter to be registered");
      }

      expect(getHealthySyncSinceMs()).toBeUndefined();

      hoisted.client.emit("sync.state", "SYNCING", "RECONNECTING", undefined);
      const firstHealthySyncSinceMs = Date.now();
      expect(getHealthySyncSinceMs()).toBe(firstHealthySyncSinceMs);

      await vi.advanceTimersByTimeAsync(3_000);
      hoisted.client.emit("sync.state", "CATCHUP", "SYNCING", undefined);
      expect(getHealthySyncSinceMs()).toBe(firstHealthySyncSinceMs);

      await vi.advanceTimersByTimeAsync(2_000);
      hoisted.client.emit("sync.state", "PREPARED", "CATCHUP", undefined);
      expect(getHealthySyncSinceMs()).toBe(firstHealthySyncSinceMs);

      await vi.advanceTimersByTimeAsync(5_000);
      hoisted.client.emit("sync.state", "RECONNECTING", "SYNCING", new Error("network flap"));
      expect(getHealthySyncSinceMs()).toBeUndefined();

      await vi.advanceTimersByTimeAsync(7_000);
      hoisted.client.emit("sync.state", "SYNCING", "RECONNECTING", undefined);
      const rearmedHealthySyncSinceMs = Date.now();
      expect(getHealthySyncSinceMs()).toBe(rearmedHealthySyncSinceMs);

      abortController.abort();
      await expect(monitorPromise).resolves.toBeUndefined();

      hoisted.client.emit("sync.state", "RECONNECTING", "SYNCING", new Error("late noise"));
      expect(getHealthySyncSinceMs()).toBe(rearmedHealthySyncSinceMs);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates room-message handler failures to the ingress owner", async () => {
    const abortController = new AbortController();
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
      const monitorPromise = monitorMatrixProvider({ abortSignal: abortController.signal });
      await waitForCallOrderEntry("start-client");

      const onRoomMessage = registeredRoomMessageHandler();

      await expect(onRoomMessage("!room:example.org", { event_id: "$event" })).rejects.toThrow(
        "room handler exploded",
      );
      await Promise.resolve();

      expect(unhandled).toHaveLength(0);

      abortController.abort();
      await monitorPromise;
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("fails the channel task when Matrix sync emits an unexpected fatal error", async () => {
    const abortController = new AbortController();
    const monitorPromise = monitorMatrixProvider({
      abortSignal: abortController.signal,
      setStatus: hoisted.setStatus,
    });

    await waitForCallOrderEntry("start-client");

    hoisted.client.emit("sync.unexpected_error", new Error("sync exploded"));

    await expect(monitorPromise).rejects.toThrow("sync exploded");
    expectPersistRelease();
    expectStatusCallFields({
      accountId: "default",
      connected: false,
      healthState: "error",
      lastError: "sync exploded",
    });
  });

  it("releases the prepared client when startup fails before later resources exist", async () => {
    hoisted.client.bindSyncIngress.mockRejectedValueOnce(new Error("ingress failed"));

    await expect(
      monitorMatrixProvider({
        setStatus: hoisted.setStatus,
      }),
    ).rejects.toThrow("ingress failed");

    expectPersistRelease();
    expectLastStatusFields({
      accountId: "default",
      connected: false,
      healthState: "error",
      lastError: "ingress failed",
    });
  });

  it("aborts stalled startup promptly and releases the shared client without persist", async () => {
    const abortController = new AbortController();
    hoisted.resolveSharedMatrixClient.mockImplementation(async (abortSignal?: AbortSignal) => {
      hoisted.callOrder.push("start-client");
      return await rejectOnAbort<typeof hoisted.client>(abortSignal);
    });

    const monitorPromise = monitorMatrixProvider({ abortSignal: abortController.signal });

    await waitForCallOrderEntry("start-client");

    abortController.abort();

    await expect(monitorPromise).resolves.toBeUndefined();
    expect(hoisted.releaseSharedClientInstance).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "stop" }),
    );
    expect(hoisted.client.drainPendingDecryptions).not.toHaveBeenCalled();
  });

  it("aborts during startup maintenance and releases the shared client without persist", async () => {
    const abortController = new AbortController();
    const handler = vi.fn(async () => {});
    hoisted.createMatrixRoomMessageHandler.mockReturnValue(handler);
    hoisted.runMatrixStartupMaintenance.mockImplementation(
      async (params: { abortSignal?: AbortSignal }) =>
        await rejectOnAbort<void>(params.abortSignal),
    );

    const monitorPromise = monitorMatrixProvider({ abortSignal: abortController.signal });

    await flushUntil(
      () => hoisted.runMatrixStartupMaintenance.mock.calls.length === 1,
      "expected startup maintenance to run",
    );

    abortController.abort();

    await expect(monitorPromise).resolves.toBeUndefined();
    expect(hoisted.releaseSharedClientInstance).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "stop" }),
    );
    expect(hoisted.client.drainPendingDecryptions).not.toHaveBeenCalled();
    await expect(
      registeredRoomMessageHandler()("!room:example.org", { event_id: "$late" }),
    ).rejects.toThrow("Matrix monitor is stopped");
    expect(handler).not.toHaveBeenCalled();
  });

  it("disposes resources installed after forced retirement wins setup", async () => {
    const stopLateManager = vi.fn();
    const managerReady = createDeferred<{
      accountId: string;
      stop: typeof stopLateManager;
    }>();
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
    expect(hoisted.releaseSharedClientInstance).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "stop" }),
    );
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
    expect(hoisted.stopThreadBindingManager).toHaveBeenCalledTimes(1);
  });

  it("starts monitoring without waiting for backfill but joins it during retirement", async () => {
    const backfill = createDeferred<undefined>();
    hoisted.backfillMatrixAuthDeviceIdAfterStartup.mockImplementation(() => backfill.promise);

    const abortController = new AbortController();
    const monitorPromise = monitorMatrixProvider({ abortSignal: abortController.signal });

    await waitForCallOrderEntry("start-client");
    expect(hoisted.backfillMatrixAuthDeviceIdAfterStartup).toHaveBeenCalledTimes(1);
    const backfillParams = mockCallArg(hoisted.backfillMatrixAuthDeviceIdAfterStartup) as {
      abortSignal?: AbortSignal;
    };
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

    const startSignal = mockCallArg(hoisted.resolveSharedMatrixClient, 0, 0) as AbortSignal;
    const backfillParams = mockCallArg(hoisted.backfillMatrixAuthDeviceIdAfterStartup) as {
      abortSignal?: AbortSignal;
    };
    const runtimeContextParams = mockCallArg(hoisted.registerChannelRuntimeContext) as {
      abortSignal?: AbortSignal;
    };
    const maintenanceParams = mockCallArg(hoisted.runMatrixStartupMaintenance) as {
      abortSignal?: AbortSignal;
    };
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
    const abortController = new AbortController();
    const handlerDone = createDeferred<void>();
    const managerDone = createDeferred<void>();

    hoisted.createMatrixRoomMessageHandler.mockReturnValue(
      vi.fn(async (_roomId: string, event: unknown) => {
        const eventId = (event as { event_id: string }).event_id;
        hoisted.callOrder.push(`handler-start:${eventId}`);
        await handlerDone.promise;
        hoisted.callOrder.push(`handler-done:${eventId}`);
      }),
    );
    hoisted.client.drainPendingDecryptions.mockImplementation(async () => {
      hoisted.callOrder.push("drain-decrypts");
    });
    hoisted.stopThreadBindingManager.mockImplementation(async () => {
      hoisted.callOrder.push("stop-manager");
      await managerDone.promise;
      hoisted.callOrder.push("manager-stopped");
    });
    hoisted.releaseSharedClientInstance.mockImplementation(async () => {
      await hoisted.client.drainPendingDecryptions();
      await hoisted.runRegisteredMonitorRetirement();
      hoisted.callOrder.push("release-client");
    });

    const monitorPromise = monitorMatrixProvider({ abortSignal: abortController.signal });
    await waitForCallOrderEntry("start-client");
    const onRoomMessage = registeredRoomMessageHandler();

    const roomMessagePromise = onRoomMessage("!room:example.org", { event_id: "$event" });
    abortController.abort();
    await waitForCallOrderEntry("dispose-monitor-events");
    expect(hoisted.callOrder).not.toContain("stop-manager");
    expect(hoisted.callOrder).not.toContain("release-client");

    await expect(onRoomMessage("!room:example.org", { event_id: "$late" })).rejects.toThrow(
      "Matrix monitor is stopped",
    );
    expect(hoisted.callOrder).not.toContain("handler-start:$late");

    handlerDone.resolve();
    await roomMessagePromise;
    await waitForCallOrderEntry("stop-manager");
    expect(hoisted.callOrder).not.toContain("release-client");

    managerDone.resolve();
    await monitorPromise;

    expect(hoisted.callOrder.indexOf("drain-decrypts")).toBeLessThan(
      hoisted.callOrder.indexOf("dispose-auto-join"),
    );
    expect(hoisted.callOrder.indexOf("dispose-auto-join")).toBeLessThan(
      hoisted.callOrder.indexOf("handler-done:$event"),
    );
    expect(hoisted.callOrder.indexOf("dispose-monitor-events")).toBeLessThan(
      hoisted.callOrder.indexOf("handler-done:$event"),
    );
    expect(hoisted.callOrder.indexOf("handler-done:$event")).toBeLessThan(
      hoisted.callOrder.indexOf("stop-manager"),
    );
    expect(hoisted.callOrder.indexOf("stop-manager")).toBeLessThan(
      hoisted.callOrder.indexOf("manager-stopped"),
    );
    expect(hoisted.callOrder.indexOf("manager-stopped")).toBeLessThan(
      hoisted.callOrder.indexOf("release-client"),
    );
  });

  it("cleans up local monitor work after a retained shared-client release", async () => {
    const abortController = new AbortController();
    const handlerDone = createDeferred<void>();
    hoisted.createMatrixRoomMessageHandler.mockReturnValue(
      vi.fn(async () => {
        hoisted.callOrder.push("handler-start");
        await handlerDone.promise;
        hoisted.callOrder.push("handler-done");
      }),
    );
    hoisted.stopThreadBindingManager.mockImplementation(() => {
      hoisted.callOrder.push("stop-manager");
    });
    hoisted.releaseSharedClientInstance.mockImplementation(async () => {
      await hoisted.runRegisteredMonitorRetirement();
      hoisted.callOrder.push("release-retained");
    });

    const monitorPromise = monitorMatrixProvider({ abortSignal: abortController.signal });
    await waitForCallOrderEntry("start-client");
    const onRoomMessage = registeredRoomMessageHandler();

    const roomMessagePromise = onRoomMessage("!room:example.org", { event_id: "$event" });
    await waitForCallOrderEntry("handler-start");
    abortController.abort();
    await waitForCallOrderEntry("dispose-monitor-events");

    expect(hoisted.client.drainPendingDecryptions).not.toHaveBeenCalled();
    expect(hoisted.callOrder).not.toContain("release-retained");

    handlerDone.resolve();
    await roomMessagePromise;
    await monitorPromise;

    expect(hoisted.callOrder.indexOf("handler-done")).toBeLessThan(
      hoisted.callOrder.indexOf("stop-manager"),
    );
    expect(hoisted.callOrder.indexOf("stop-manager")).toBeLessThan(
      hoisted.callOrder.indexOf("release-retained"),
    );
  });

  it("wires exact room config as a direct-room classifier veto", async () => {
    (hoisted.accountConfig as { rooms?: Record<string, unknown> }).rooms = {
      "!room:example.org": { requireMention: true },
      "*": { requireMention: false },
    };

    await startMonitorAndAbortAfterStartup();

    const trackerOpts = directRoomTrackerOptions();
    if (!trackerOpts?.isExplicitlyConfiguredRoom) {
      throw new Error("explicit room config callback was not wired");
    }

    expect(await trackerOpts.isExplicitlyConfiguredRoom("!room:example.org")).toBe(true);
    expect(await trackerOpts.isExplicitlyConfiguredRoom("!other:example.org")).toBe(false);
    expect(hoisted.getRoomInfo).not.toHaveBeenCalled();
  });

  it("wires alias room config as a direct-room classifier veto", async () => {
    (hoisted.accountConfig as { rooms?: Record<string, unknown> }).rooms = {
      "#ops:example.org": { requireMention: true },
      "*": { requireMention: false },
    };
    const { resolveMatrixTargets } = await import("../../resolve-targets.js");
    vi.mocked(resolveMatrixTargets).mockResolvedValueOnce([
      {
        input: "#ops:example.org",
        resolved: true,
        id: "!room:example.org",
      },
    ]);

    await startMonitorAndAbortAfterStartup();

    const trackerOpts = directRoomTrackerOptions();
    if (!trackerOpts?.isExplicitlyConfiguredRoom) {
      throw new Error("explicit room config callback was not wired");
    }

    hoisted.getRoomInfo.mockResolvedValueOnce(roomInfo({ canonicalAlias: "#ops:example.org" }));

    expect(await trackerOpts.isExplicitlyConfiguredRoom("!room:example.org")).toBe(true);
  });

  it.each([
    ["canPromoteRecentInvite", { nameResolved: false, aliasesResolved: false }, false, false],
    ["canPromoteRecentInvite", {}, false, true],
    ["canPromoteUnmappedStrictRoom", {}, true, false],
    ["canPromoteUnmappedStrictRoom", { name: "Ops Room" }, false, false],
    [
      "shouldKeepLocallyPromotedDirectRoom",
      { nameResolved: false, aliasesResolved: false },
      undefined,
      false,
    ],
  ] satisfies Array<
    [
      (
        | "canPromoteRecentInvite"
        | "canPromoteUnmappedStrictRoom"
        | "shouldKeepLocallyPromotedDirectRoom"
      ),
      Partial<MatrixRoomInfo>,
      boolean | undefined,
      boolean,
    ]
  >)("wires %s through metadata %j to %s (wildcard=%s)", async (key, info, expected, wildcard) => {
    if (key === "canPromoteUnmappedStrictRoom") {
      hoisted.accountConfig.dm = { sessionScope: "per-room" };
    }
    if (wildcard) {
      (hoisted.accountConfig as { rooms?: Record<string, unknown> }).rooms = {
        "*": { enabled: false },
      };
    }
    await startMonitorAndAbortAfterStartup();
    const callback = expectDefined(directRoomTrackerOptions()[key], key);
    hoisted.getRoomInfo.mockResolvedValueOnce(roomInfo(info));
    await expect(callback("!room:example.org")).resolves.toBe(expected);
  });
});
