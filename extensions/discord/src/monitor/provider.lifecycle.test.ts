import { EventEmitter } from "node:events";
import type { GatewayPlugin } from "@buape/carbon/gateway";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { RuntimeEnv } from "../../../../src/runtime.js";
import type { WaitForDiscordGatewayStopParams } from "../monitor.gateway.js";
import type { MutableDiscordGateway } from "./gateway-handle.js";
import type { DiscordGatewayEvent } from "./gateway-supervisor.js";

type LifecycleParams = Parameters<
  typeof import("./provider.lifecycle.js").runDiscordGatewayLifecycle
>[0];
type MockGateway = {
  isConnected: boolean;
  options: GatewayPlugin["options"];
  disconnect: Mock<() => void>;
  connect: Mock<(resume?: boolean) => void>;
  state?: {
    sessionId?: string | null;
    resumeGatewayUrl?: string | null;
    sequence?: number | null;
  };
  sequence?: number | null;
  emitter: EventEmitter;
  ws?: EventEmitter & { terminate?: () => void };
};

const {
  attachDiscordGatewayLoggingMock,
  getDiscordGatewayEmitterMock,
  registerGatewayMock,
  stopGatewayLoggingMock,
  unregisterGatewayMock,
  waitForDiscordGatewayStopMock,
} = vi.hoisted(() => {
  const stopGatewayLoggingMock = vi.fn();
  const getDiscordGatewayEmitterMock = vi.fn<() => EventEmitter | undefined>(() => undefined);
  return {
    attachDiscordGatewayLoggingMock: vi.fn(() => stopGatewayLoggingMock),
    getDiscordGatewayEmitterMock,
    waitForDiscordGatewayStopMock: vi.fn((_params: WaitForDiscordGatewayStopParams) =>
      Promise.resolve(),
    ),
    registerGatewayMock: vi.fn(),
    unregisterGatewayMock: vi.fn(),
    stopGatewayLoggingMock,
  };
});

vi.mock("../gateway-logging.js", () => ({
  attachDiscordGatewayLogging: attachDiscordGatewayLoggingMock,
}));

vi.mock("../monitor.gateway.js", () => ({
  getDiscordGatewayEmitter: getDiscordGatewayEmitterMock,
  waitForDiscordGatewayStop: waitForDiscordGatewayStopMock,
}));

vi.mock("./gateway-registry.js", () => ({
  registerGateway: registerGatewayMock,
  unregisterGateway: unregisterGatewayMock,
}));

describe("runDiscordGatewayLifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    attachDiscordGatewayLoggingMock.mockClear();
    getDiscordGatewayEmitterMock.mockClear();
    waitForDiscordGatewayStopMock.mockClear();
    registerGatewayMock.mockClear();
    unregisterGatewayMock.mockClear();
    stopGatewayLoggingMock.mockClear();
  });

  const createLifecycleHarness = (params?: {
    accountId?: string;
    start?: () => Promise<void>;
    stop?: () => Promise<void>;
    isDisallowedIntentsError?: (err: unknown) => boolean;
    pendingGatewayEvents?: DiscordGatewayEvent[];
    gateway?: MockGateway;
  }) => {
    const gateway =
      params?.gateway ??
      (() => {
        const defaultGateway = createGatewayHarness().gateway;
        defaultGateway.isConnected = true;
        return defaultGateway;
      })();
    const start = vi.fn(params?.start ?? (async () => undefined));
    const stop = vi.fn(params?.stop ?? (async () => undefined));
    const threadStop = vi.fn();
    const runtimeLog = vi.fn();
    const runtimeError = vi.fn();
    const runtimeExit = vi.fn();
    const pendingGatewayEvents = params?.pendingGatewayEvents ?? [];
    const gatewaySupervisor = {
      attachLifecycle: vi.fn(),
      detachLifecycle: vi.fn(),
      drainPending: vi.fn((handler: (event: DiscordGatewayEvent) => "continue" | "stop") => {
        if (pendingGatewayEvents.length === 0) {
          return "continue";
        }
        const queued = [...pendingGatewayEvents];
        pendingGatewayEvents.length = 0;
        for (const event of queued) {
          if (handler(event) === "stop") {
            return "stop";
          }
        }
        return "continue";
      }),
      dispose: vi.fn(),
      emitter: gateway.emitter,
    };
    const statusSink = vi.fn();
    const runtime: RuntimeEnv = {
      log: runtimeLog,
      error: runtimeError,
      exit: runtimeExit,
    };
    return {
      start,
      stop,
      threadStop,
      runtimeLog,
      runtimeError,
      gatewaySupervisor,
      statusSink,
      lifecycleParams: {
        accountId: params?.accountId ?? "default",
        gateway: gateway as unknown as MutableDiscordGateway,
        runtime,
        isDisallowedIntentsError: params?.isDisallowedIntentsError ?? (() => false),
        voiceManager: null,
        voiceManagerRef: { current: null },
        execApprovalsHandler: { start, stop },
        threadBindings: { stop: threadStop },
        gatewaySupervisor,
        statusSink,
        abortSignal: undefined as AbortSignal | undefined,
      } satisfies LifecycleParams,
    };
  };

  function expectLifecycleCleanup(params: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    threadStop: ReturnType<typeof vi.fn>;
    waitCalls: number;
    gatewaySupervisor: { detachLifecycle: ReturnType<typeof vi.fn> };
  }) {
    expect(params.start).toHaveBeenCalledTimes(1);
    expect(params.stop).toHaveBeenCalledTimes(1);
    expect(waitForDiscordGatewayStopMock).toHaveBeenCalledTimes(params.waitCalls);
    expect(unregisterGatewayMock).toHaveBeenCalledWith("default");
    expect(stopGatewayLoggingMock).toHaveBeenCalledTimes(1);
    expect(params.threadStop).toHaveBeenCalledTimes(1);
    expect(params.gatewaySupervisor.detachLifecycle).toHaveBeenCalledTimes(1);
  }

  function createGatewayHarness(params?: {
    state?: {
      sessionId?: string | null;
      resumeGatewayUrl?: string | null;
      sequence?: number | null;
    };
    sequence?: number | null;
    ws?: EventEmitter & { terminate?: () => void };
  }): { emitter: EventEmitter; gateway: MockGateway } {
    const emitter = new EventEmitter();
    const gateway: MockGateway = {
      isConnected: false,
      options: { intents: 0 } as GatewayPlugin["options"],
      disconnect: vi.fn(),
      connect: vi.fn(),
      ...(params?.state ? { state: params.state } : {}),
      ...(params?.sequence !== undefined ? { sequence: params.sequence } : {}),
      ...(params?.ws ? { ws: params.ws } : {}),
      emitter,
    };
    return { emitter, gateway };
  }

  async function emitGatewayOpenAndWait(emitter: EventEmitter, delayMs = 30000): Promise<void> {
    emitter.emit("debug", "WebSocket connection opened");
    await vi.advanceTimersByTimeAsync(delayMs);
  }

  function createGatewayEvent(
    type: DiscordGatewayEvent["type"],
    message: string,
  ): DiscordGatewayEvent {
    const err = new Error(message);
    return {
      type,
      err,
      message: String(err),
      shouldStopLifecycle: type !== "other",
    };
  }

  function expectGatewaySessionStateCleared(gateway: {
    state?: {
      sessionId?: string | null;
      resumeGatewayUrl?: string | null;
      sequence?: number | null;
    };
    sequence?: number | null;
  }) {
    if (!gateway.state) {
      throw new Error("gateway state was not initialized");
    }
    expect(gateway.state.sessionId).toBeNull();
    expect(gateway.state.resumeGatewayUrl).toBeNull();
    expect(gateway.state.sequence).toBeNull();
    expect(gateway.sequence).toBeNull();
  }

  it("cleans up thread bindings when exec approvals startup fails", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    const { lifecycleParams, start, stop, threadStop, gatewaySupervisor } = createLifecycleHarness({
      start: async () => {
        throw new Error("startup failed");
      },
    });

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).rejects.toThrow("startup failed");

    expectLifecycleCleanup({
      start,
      stop,
      threadStop,
      waitCalls: 0,
      gatewaySupervisor,
    });
  });

  it("cleans up when gateway wait fails after startup", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    waitForDiscordGatewayStopMock.mockRejectedValueOnce(new Error("gateway wait failed"));
    const { lifecycleParams, start, stop, threadStop, gatewaySupervisor } =
      createLifecycleHarness();

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).rejects.toThrow(
      "gateway wait failed",
    );

    expectLifecycleCleanup({
      start,
      stop,
      threadStop,
      waitCalls: 1,
      gatewaySupervisor,
    });
  });

  it("cleans up after successful gateway wait", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    const { lifecycleParams, start, stop, threadStop, gatewaySupervisor } =
      createLifecycleHarness();

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).resolves.toBeUndefined();

    expectLifecycleCleanup({
      start,
      stop,
      threadStop,
      waitCalls: 1,
      gatewaySupervisor,
    });
  });

  it("pushes connected status when gateway is already connected at lifecycle start", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    const { emitter, gateway } = createGatewayHarness();
    gateway.isConnected = true;
    getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);

    const { lifecycleParams, statusSink } = createLifecycleHarness({ gateway });
    await expect(runDiscordGatewayLifecycle(lifecycleParams)).resolves.toBeUndefined();

    const connectedCall = statusSink.mock.calls.find((call) => {
      const patch = (call[0] ?? {}) as Record<string, unknown>;
      return patch.connected === true;
    });
    if (!connectedCall) {
      throw new Error("connected status update was not emitted");
    }
    expect(connectedCall[0]).toMatchObject({
      connected: true,
      lastDisconnect: null,
    });
    expect(connectedCall[0].lastConnectedAt).toBeTypeOf("number");
  });

  it("forces a fresh reconnect when startup never reaches READY, then recovers", async () => {
    vi.useFakeTimers();
    try {
      const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
      const { emitter, gateway } = createGatewayHarness();
      getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
      gateway.connect.mockImplementation((_resume?: boolean) => {
        setTimeout(() => {
          gateway.isConnected = true;
        }, 1_000);
      });

      const { lifecycleParams, runtimeError } = createLifecycleHarness({ gateway });
      const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);
      await vi.advanceTimersByTimeAsync(15_000 + 1_000);
      await expect(lifecyclePromise).resolves.toBeUndefined();

      expect(runtimeError).toHaveBeenCalledWith(
        expect.stringContaining("gateway was not ready after 15000ms"),
      );
      expect(gateway.disconnect).toHaveBeenCalledTimes(1);
      expect(gateway.connect).toHaveBeenCalledTimes(1);
      expect(gateway.connect).toHaveBeenCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears resume state and suppresses socket-driven auto-resume during forced startup reconnects", async () => {
    vi.useFakeTimers();
    try {
      const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
      const pendingGatewayEvents: DiscordGatewayEvent[] = [];
      const socket = new EventEmitter();
      const { emitter, gateway } = createGatewayHarness({
        state: {
          sessionId: "stale-session",
          resumeGatewayUrl: "wss://gateway.discord.gg",
          sequence: 123,
        },
        sequence: 123,
        ws: socket,
      });
      getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);

      socket.on("error", (err) => {
        pendingGatewayEvents.push({
          type: "other",
          err,
          message: String(err),
          shouldStopLifecycle: false,
        });
      });
      socket.on("close", () => {
        gateway.connect(true);
      });
      gateway.disconnect.mockImplementation(() => {
        setTimeout(() => {
          socket.emit(
            "error",
            new Error("WebSocket was closed before the connection was established"),
          );
          socket.emit("close", 1006, "");
        }, 1);
      });
      gateway.connect.mockImplementation((resume?: boolean) => {
        if (resume === false) {
          setTimeout(() => {
            gateway.isConnected = true;
          }, 1_000);
        }
      });

      const { lifecycleParams, runtimeError } = createLifecycleHarness({
        gateway,
        pendingGatewayEvents,
      });
      const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);
      await vi.advanceTimersByTimeAsync(17_000);
      await expect(lifecyclePromise).resolves.toBeUndefined();

      expect(gateway.connect).toHaveBeenCalledTimes(1);
      expect(gateway.connect).toHaveBeenCalledWith(false);
      expect(runtimeError).not.toHaveBeenCalledWith(
        expect.stringContaining("WebSocket was closed before the connection was established"),
      );
      expectGatewaySessionStateCleared(gateway);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for forced terminate to close the old socket before reconnecting", async () => {
    vi.useFakeTimers();
    try {
      const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
      const socket = Object.assign(new EventEmitter(), {
        terminate: vi.fn(() => {
          setTimeout(() => {
            socket.emit(
              "error",
              new Error("WebSocket was closed before the connection was established"),
            );
            socket.emit("close", 1006, "");
          }, 1);
        }),
      });
      const { emitter, gateway } = createGatewayHarness({ ws: socket });
      getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
      gateway.connect.mockImplementation((_resume?: boolean) => {
        setTimeout(() => {
          gateway.isConnected = true;
        }, 1_000);
      });

      const { lifecycleParams, runtimeError } = createLifecycleHarness({ gateway });
      const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);
      await vi.advanceTimersByTimeAsync(15_000 + 5_000 + 1_500);
      await expect(lifecyclePromise).resolves.toBeUndefined();

      expect(socket.terminate).toHaveBeenCalledTimes(1);
      expect(gateway.connect).toHaveBeenCalledTimes(1);
      expect(gateway.connect).toHaveBeenCalledWith(false);
      expect(runtimeError).toHaveBeenCalledWith(
        expect.stringContaining("attempting forced terminate before giving up"),
      );
      expect(runtimeError).not.toHaveBeenCalledWith(
        expect.stringContaining("WebSocket was closed before the connection was established"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when forced terminate still does not close the old socket", async () => {
    vi.useFakeTimers();
    try {
      const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
      const socket = Object.assign(new EventEmitter(), {
        terminate: vi.fn(() => {
          setTimeout(() => {
            socket.emit(
              "error",
              new Error("WebSocket was closed before the connection was established"),
            );
          }, 1);
        }),
      });
      const { emitter, gateway } = createGatewayHarness({ ws: socket });
      getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
      const { lifecycleParams, start, stop, threadStop, runtimeError, gatewaySupervisor } =
        createLifecycleHarness({ gateway });

      const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);
      lifecyclePromise.catch(() => {});
      await vi.advanceTimersByTimeAsync(15_000 + 5_000 + 1_500);
      await expect(lifecyclePromise).rejects.toThrow(
        "discord gateway socket did not close within 5000ms before reconnect",
      );

      expect(socket.terminate).toHaveBeenCalledTimes(1);
      expect(gateway.connect).not.toHaveBeenCalled();
      expect(runtimeError).toHaveBeenCalledWith(
        expect.stringContaining("force-stopping instead of opening a parallel socket"),
      );
      expect(runtimeError).not.toHaveBeenCalledWith(
        expect.stringContaining("WebSocket was closed before the connection was established"),
      );
      expectLifecycleCleanup({
        start,
        stop,
        threadStop,
        waitCalls: 0,
        gatewaySupervisor,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reconnect after lifecycle shutdown begins during socket drain", async () => {
    vi.useFakeTimers();
    try {
      const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
      const socket = new EventEmitter();
      const { emitter, gateway } = createGatewayHarness({ ws: socket });
      getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
      gateway.disconnect.mockImplementation(() => {
        setTimeout(() => {
          socket.emit("close", 1000, "");
        }, 1_000);
      });

      const abortController = new AbortController();
      const { lifecycleParams } = createLifecycleHarness({ gateway });
      lifecycleParams.abortSignal = abortController.signal;

      const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);
      await vi.advanceTimersByTimeAsync(15_100);
      abortController.abort();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(lifecyclePromise).resolves.toBeUndefined();

      expect(gateway.connect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats drain timeout as a graceful stop after lifecycle abort", async () => {
    vi.useFakeTimers();
    try {
      const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
      const socket = new EventEmitter();
      const { emitter, gateway } = createGatewayHarness({ ws: socket });
      getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);

      const abortController = new AbortController();
      const { lifecycleParams, start, stop, threadStop, runtimeError, gatewaySupervisor } =
        createLifecycleHarness({ gateway });
      lifecycleParams.abortSignal = abortController.signal;

      const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);
      await vi.advanceTimersByTimeAsync(15_100);
      abortController.abort();
      await vi.advanceTimersByTimeAsync(5_500);
      await expect(lifecyclePromise).resolves.toBeUndefined();

      expect(gateway.connect).not.toHaveBeenCalled();
      expect(runtimeError).not.toHaveBeenCalledWith(
        expect.stringContaining("gateway socket did not close within 5000ms before reconnect"),
      );
      expectLifecycleCleanup({
        start,
        stop,
        threadStop,
        waitCalls: 1,
        gatewaySupervisor,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails fast when startup never reaches READY after a forced reconnect", async () => {
    vi.useFakeTimers();
    try {
      const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
      const { emitter, gateway } = createGatewayHarness();
      getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
      const { lifecycleParams, start, stop, threadStop, gatewaySupervisor } =
        createLifecycleHarness({ gateway });

      const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);
      lifecyclePromise.catch(() => {});
      await vi.advanceTimersByTimeAsync(15_000 * 2 + 1_000);
      await expect(lifecyclePromise).rejects.toThrow(
        "discord gateway did not reach READY within 15000ms after a forced reconnect",
      );

      expect(gateway.disconnect).toHaveBeenCalledTimes(1);
      expect(gateway.connect).toHaveBeenCalledTimes(1);
      expect(gateway.connect).toHaveBeenCalledWith(false);
      expectLifecycleCleanup({
        start,
        stop,
        threadStop,
        waitCalls: 0,
        gatewaySupervisor,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles queued disallowed intents errors without waiting for gateway events", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    const { lifecycleParams, start, stop, threadStop, runtimeError, gatewaySupervisor } =
      createLifecycleHarness({
        pendingGatewayEvents: [
          createGatewayEvent("disallowed-intents", "Fatal Gateway error: 4014"),
        ],
        isDisallowedIntentsError: (err) => String(err).includes("4014"),
      });

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).resolves.toBeUndefined();

    expect(runtimeError).toHaveBeenCalledWith(
      expect.stringContaining("discord: gateway closed with code 4014"),
    );
    expectLifecycleCleanup({
      start,
      stop,
      threadStop,
      waitCalls: 0,
      gatewaySupervisor,
    });
  });

  it("logs queued non-fatal startup gateway errors and continues", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    const { lifecycleParams, start, stop, threadStop, runtimeError, gatewaySupervisor } =
      createLifecycleHarness({
        pendingGatewayEvents: [createGatewayEvent("other", "transient startup error")],
      });

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).resolves.toBeUndefined();

    expect(runtimeError).toHaveBeenCalledWith(
      expect.stringContaining("discord gateway error: Error: transient startup error"),
    );
    expectLifecycleCleanup({
      start,
      stop,
      threadStop,
      waitCalls: 1,
      gatewaySupervisor,
    });
  });

  it("throws queued non-disallowed fatal gateway errors", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    const { lifecycleParams, start, stop, threadStop, gatewaySupervisor } = createLifecycleHarness({
      pendingGatewayEvents: [createGatewayEvent("fatal", "Fatal Gateway error: 4000")],
    });

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).rejects.toThrow(
      "Fatal Gateway error: 4000",
    );

    expectLifecycleCleanup({
      start,
      stop,
      threadStop,
      waitCalls: 0,
      gatewaySupervisor,
    });
  });

  it("surfaces fatal startup gateway errors while waiting for READY", async () => {
    vi.useFakeTimers();
    try {
      const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
      const pendingGatewayEvents: DiscordGatewayEvent[] = [];
      const { emitter, gateway } = createGatewayHarness();
      getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
      const { lifecycleParams, start, stop, threadStop, runtimeError, gatewaySupervisor } =
        createLifecycleHarness({
          gateway,
          pendingGatewayEvents,
        });

      setTimeout(() => {
        pendingGatewayEvents.push(createGatewayEvent("fatal", "Fatal Gateway error: 4001"));
      }, 1_000);

      const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);
      lifecyclePromise.catch(() => {});
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(lifecyclePromise).rejects.toThrow("Fatal Gateway error: 4001");

      expect(runtimeError).toHaveBeenCalledWith(
        expect.stringContaining("discord gateway error: Error: Fatal Gateway error: 4001"),
      );
      expect(gateway.disconnect).not.toHaveBeenCalled();
      expect(gateway.connect).not.toHaveBeenCalled();
      expectLifecycleCleanup({
        start,
        stop,
        threadStop,
        waitCalls: 0,
        gatewaySupervisor,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries stalled HELLO with resume before forcing fresh identify", async () => {
    vi.useFakeTimers();
    try {
      const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
      const { emitter, gateway } = createGatewayHarness({
        state: {
          sessionId: "session-1",
          resumeGatewayUrl: "wss://gateway.discord.gg",
          sequence: 123,
        },
        sequence: 123,
      });
      gateway.isConnected = true;
      getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
      waitForDiscordGatewayStopMock.mockImplementationOnce(async () => {
        emitter.emit("debug", "WebSocket connection closed with code 1006");
        gateway.isConnected = false;
        await emitGatewayOpenAndWait(emitter);
        await emitGatewayOpenAndWait(emitter);
        await emitGatewayOpenAndWait(emitter);
      });

      const { lifecycleParams } = createLifecycleHarness({ gateway });
      await expect(runDiscordGatewayLifecycle(lifecycleParams)).resolves.toBeUndefined();

      expect(gateway.disconnect).toHaveBeenCalledTimes(3);
      expect(gateway.connect).toHaveBeenNthCalledWith(1, true);
      expect(gateway.connect).toHaveBeenNthCalledWith(2, true);
      expect(gateway.connect).toHaveBeenNthCalledWith(3, false);
      expectGatewaySessionStateCleared(gateway);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets HELLO stall counter after a successful reconnect that drops quickly", async () => {
    vi.useFakeTimers();
    try {
      const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
      const { emitter, gateway } = createGatewayHarness({
        state: {
          sessionId: "session-2",
          resumeGatewayUrl: "wss://gateway.discord.gg",
          sequence: 456,
        },
        sequence: 456,
      });
      gateway.isConnected = true;
      getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
      waitForDiscordGatewayStopMock.mockImplementationOnce(async () => {
        emitter.emit("debug", "WebSocket connection closed with code 1006");
        gateway.isConnected = false;
        await emitGatewayOpenAndWait(emitter);

        await emitGatewayOpenAndWait(emitter);

        // Successful reconnect (READY/RESUMED sets isConnected=true), then
        // quick drop before the HELLO timeout window finishes.
        gateway.isConnected = true;
        await emitGatewayOpenAndWait(emitter, 10);
        emitter.emit("debug", "WebSocket connection closed with code 1006");
        gateway.isConnected = false;

        await emitGatewayOpenAndWait(emitter);
        await emitGatewayOpenAndWait(emitter);
      });

      const { lifecycleParams } = createLifecycleHarness({ gateway });
      await expect(runDiscordGatewayLifecycle(lifecycleParams)).resolves.toBeUndefined();

      expect(gateway.connect).toHaveBeenCalledTimes(4);
      expect(gateway.connect).toHaveBeenNthCalledWith(1, true);
      expect(gateway.connect).toHaveBeenNthCalledWith(2, true);
      expect(gateway.connect).toHaveBeenNthCalledWith(3, true);
      expect(gateway.connect).toHaveBeenNthCalledWith(4, true);
      expect(gateway.connect).not.toHaveBeenCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("force-stops when reconnect stalls after a close event", async () => {
    vi.useFakeTimers();
    try {
      const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
      const { emitter, gateway } = createGatewayHarness();
      gateway.isConnected = true;
      getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
      waitForDiscordGatewayStopMock.mockImplementationOnce(
        (waitParams: WaitForDiscordGatewayStopParams) =>
          new Promise<void>((_resolve, reject) => {
            waitParams.registerForceStop?.((err) => reject(err));
          }),
      );
      const { lifecycleParams } = createLifecycleHarness({ gateway });

      const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);
      lifecyclePromise.catch(() => {});
      emitter.emit("debug", "WebSocket connection closed with code 1006");

      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
      await expect(lifecyclePromise).rejects.toThrow("reconnect watchdog timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not force-stop when reconnect resumes before watchdog timeout", async () => {
    vi.useFakeTimers();
    try {
      const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
      const { emitter, gateway } = createGatewayHarness();
      gateway.isConnected = true;
      getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
      let resolveWait: (() => void) | undefined;
      waitForDiscordGatewayStopMock.mockImplementationOnce(
        (waitParams: WaitForDiscordGatewayStopParams) =>
          new Promise<void>((resolve, reject) => {
            resolveWait = resolve;
            waitParams.registerForceStop?.((err) => reject(err));
          }),
      );
      const { lifecycleParams, runtimeLog } = createLifecycleHarness({ gateway });

      const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);
      emitter.emit("debug", "WebSocket connection closed with code 1006");
      await vi.advanceTimersByTimeAsync(60_000);

      gateway.isConnected = true;
      emitter.emit("debug", "WebSocket connection opened");
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);

      expect(runtimeLog).not.toHaveBeenCalledWith(
        expect.stringContaining("reconnect watchdog timeout"),
      );
      resolveWait?.();
      await expect(lifecyclePromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses reconnect-exhausted already queued before shutdown", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    const pendingGatewayEvents: DiscordGatewayEvent[] = [];
    const abortController = new AbortController();

    const emitter = new EventEmitter();
    const gateway: MockGateway = {
      isConnected: true,
      options: { intents: 0, reconnect: { maxAttempts: 50 } } as GatewayPlugin["options"],
      disconnect: vi.fn(),
      connect: vi.fn(),
      emitter,
    };
    getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);

    const { lifecycleParams, runtimeLog, runtimeError } = createLifecycleHarness({
      gateway,
      pendingGatewayEvents,
    });
    lifecycleParams.abortSignal = abortController.signal;

    // Start lifecycle; it yields at execApprovalsHandler.start(). We then
    // queue a reconnect-exhausted event and abort. The lifecycle resumes and
    // drains the queued event before shutdown teardown flips lifecycleStopping,
    // so drainPending must treat it as a graceful stop.
    const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);

    pendingGatewayEvents.push(
      createGatewayEvent(
        "reconnect-exhausted",
        "Max reconnect attempts (0) reached after code 1005",
      ),
    );
    abortController.abort();

    await expect(lifecyclePromise).resolves.toBeUndefined();
    expect(runtimeLog).not.toHaveBeenCalledWith(
      expect.stringContaining("ignoring expected reconnect-exhausted during shutdown"),
    );
    expect(runtimeError).toHaveBeenCalledWith(expect.stringContaining("Max reconnect attempts"));
  });

  it("gracefully stops on reconnect-exhausted from deliberate maxAttempts=0 even before shutdown", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    const pendingGatewayEvents: DiscordGatewayEvent[] = [];

    const emitter = new EventEmitter();
    const gateway: MockGateway = {
      isConnected: true,
      options: { intents: 0, reconnect: { maxAttempts: 50 } } as GatewayPlugin["options"],
      disconnect: vi.fn(),
      connect: vi.fn(),
      emitter,
    };
    getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);

    const { lifecycleParams } = createLifecycleHarness({
      gateway,
      pendingGatewayEvents,
    });

    pendingGatewayEvents.push(
      createGatewayEvent(
        "reconnect-exhausted",
        "Max reconnect attempts (0) reached after code 1005",
      ),
    );

    // Deliberate maxAttempts=0 disconnect should not crash the gateway
    await expect(runDiscordGatewayLifecycle(lifecycleParams)).resolves.not.toThrow();
  });

  it("rejects reconnect-exhausted with non-zero maxAttempts when shutdown has not begun", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    const pendingGatewayEvents: DiscordGatewayEvent[] = [];

    const emitter = new EventEmitter();
    const gateway: MockGateway = {
      isConnected: true,
      options: { intents: 0, reconnect: { maxAttempts: 50 } } as GatewayPlugin["options"],
      disconnect: vi.fn(),
      connect: vi.fn(),
      emitter,
    };
    getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);

    const { lifecycleParams } = createLifecycleHarness({
      gateway,
      pendingGatewayEvents,
    });

    pendingGatewayEvents.push(
      createGatewayEvent(
        "reconnect-exhausted",
        "Max reconnect attempts (50) reached after code 1005",
      ),
    );

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).rejects.toThrow(
      "Max reconnect attempts",
    );
  });

  it("does not push connected: true when abortSignal is already aborted", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    const emitter = new EventEmitter();
    const gateway: MockGateway = {
      isConnected: true,
      options: { intents: 0, reconnect: { maxAttempts: 3 } } as GatewayPlugin["options"],
      disconnect: vi.fn(),
      connect: vi.fn(),
      emitter,
    };
    getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);

    const abortController = new AbortController();
    abortController.abort();

    const statusUpdates: Array<Record<string, unknown>> = [];
    const statusSink = (patch: Record<string, unknown>) => {
      statusUpdates.push({ ...patch });
    };

    const { lifecycleParams } = createLifecycleHarness({ gateway });
    lifecycleParams.abortSignal = abortController.signal;
    (lifecycleParams as Record<string, unknown>).statusSink = statusSink;

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).resolves.toBeUndefined();

    // onAbort should have pushed connected: false
    const connectedFalse = statusUpdates.find((s) => s.connected === false);
    expect(connectedFalse).toEqual(expect.objectContaining({ connected: false }));

    // No connected: true should appear — the isConnected check must be
    // guarded by !lifecycleStopping to avoid contradicting the abort.
    const connectedTrue = statusUpdates.find((s) => s.connected === true);
    expect(connectedTrue).toBeUndefined();
  });
});
