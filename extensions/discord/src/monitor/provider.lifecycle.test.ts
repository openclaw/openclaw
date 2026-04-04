import { EventEmitter } from "node:events";
import type { Client } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../../../src/runtime.js";
import type { WaitForDiscordGatewayStopParams } from "../monitor.gateway.js";

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
    pendingGatewayErrors?: unknown[];
    gateway?: {
      isConnected?: boolean;
      options?: Record<string, unknown>;
      disconnect?: () => void;
      connect?: (resume?: boolean) => void;
      state?: {
        sessionId?: string | null;
        resumeGatewayUrl?: string | null;
        sequence?: number | null;
      };
      sequence?: number | null;
      emitter?: EventEmitter;
    };
  }) => {
    const start = vi.fn(params?.start ?? (async () => undefined));
    const stop = vi.fn(params?.stop ?? (async () => undefined));
    const threadStop = vi.fn();
    const runtimeLog = vi.fn();
    const runtimeError = vi.fn();
    const runtimeExit = vi.fn();
    const releaseEarlyGatewayErrorGuard = vi.fn();
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
      releaseEarlyGatewayErrorGuard,
      statusSink,
      lifecycleParams: {
        accountId: params?.accountId ?? "default",
        client: {
          getPlugin: vi.fn((name: string) => (name === "gateway" ? params?.gateway : undefined)),
        } as unknown as Client,
        runtime,
        isDisallowedIntentsError: params?.isDisallowedIntentsError ?? (() => false),
        voiceManager: null,
        voiceManagerRef: { current: null },
        execApprovalsHandler: { start, stop },
        threadBindings: { stop: threadStop },
        pendingGatewayErrors: params?.pendingGatewayErrors,
        releaseEarlyGatewayErrorGuard,
        statusSink,
        abortSignal: undefined as AbortSignal | undefined,
      },
    };
  };

  function expectLifecycleCleanup(params: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    threadStop: ReturnType<typeof vi.fn>;
    waitCalls: number;
    releaseEarlyGatewayErrorGuard: ReturnType<typeof vi.fn>;
  }) {
    expect(params.start).toHaveBeenCalledTimes(1);
    expect(params.stop).toHaveBeenCalledTimes(1);
    expect(waitForDiscordGatewayStopMock).toHaveBeenCalledTimes(params.waitCalls);
    expect(unregisterGatewayMock).toHaveBeenCalledWith("default");
    expect(stopGatewayLoggingMock).toHaveBeenCalledTimes(1);
    expect(params.threadStop).toHaveBeenCalledTimes(1);
    expect(params.releaseEarlyGatewayErrorGuard).toHaveBeenCalledTimes(1);
  }

  function createGatewayHarness(params?: {
    state?: {
      sessionId?: string | null;
      resumeGatewayUrl?: string | null;
      sequence?: number | null;
    };
    sequence?: number | null;
  }) {
    const emitter = new EventEmitter();
    const gateway = {
      isConnected: false,
      options: {},
      disconnect: vi.fn(),
      connect: vi.fn(),
      ...(params?.state ? { state: params.state } : {}),
      ...(params?.sequence !== undefined ? { sequence: params.sequence } : {}),
      emitter,
    };
    return { emitter, gateway };
  }

  async function emitGatewayOpenAndWait(emitter: EventEmitter, delayMs = 30000): Promise<void> {
    emitter.emit("debug", "WebSocket connection opened");
    await vi.advanceTimersByTimeAsync(delayMs);
  }

  it("cleans up thread bindings when exec approvals startup fails", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    const { lifecycleParams, start, stop, threadStop, releaseEarlyGatewayErrorGuard } =
      createLifecycleHarness({
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
      releaseEarlyGatewayErrorGuard,
    });
  });

  it("cleans up when gateway wait fails after startup", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    waitForDiscordGatewayStopMock.mockRejectedValueOnce(new Error("gateway wait failed"));
    const { lifecycleParams, start, stop, threadStop, releaseEarlyGatewayErrorGuard } =
      createLifecycleHarness();

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).rejects.toThrow(
      "gateway wait failed",
    );

    expectLifecycleCleanup({
      start,
      stop,
      threadStop,
      waitCalls: 1,
      releaseEarlyGatewayErrorGuard,
    });
  });

  it("cleans up after successful gateway wait", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    const { lifecycleParams, start, stop, threadStop, releaseEarlyGatewayErrorGuard } =
      createLifecycleHarness();

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).resolves.toBeUndefined();

    expectLifecycleCleanup({
      start,
      stop,
      threadStop,
      waitCalls: 1,
      releaseEarlyGatewayErrorGuard,
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
    expect(connectedCall).toBeDefined();
    expect(connectedCall![0]).toMatchObject({
      connected: true,
      lastDisconnect: null,
    });
    expect(connectedCall![0].lastConnectedAt).toBeTypeOf("number");
  });

  it("handles queued disallowed intents errors without waiting for gateway events", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    const {
      lifecycleParams,
      start,
      stop,
      threadStop,
      runtimeError,
      releaseEarlyGatewayErrorGuard,
    } = createLifecycleHarness({
      pendingGatewayErrors: [new Error("Fatal Gateway error: 4014")],
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
      releaseEarlyGatewayErrorGuard,
    });
  });

  it("throws queued non-disallowed fatal gateway errors", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    const { lifecycleParams, start, stop, threadStop, releaseEarlyGatewayErrorGuard } =
      createLifecycleHarness({
        pendingGatewayErrors: [new Error("Fatal Gateway error: 4000")],
      });

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).rejects.toThrow(
      "Fatal Gateway error: 4000",
    );

    expectLifecycleCleanup({
      start,
      stop,
      threadStop,
      waitCalls: 0,
      releaseEarlyGatewayErrorGuard,
    });
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
      getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
      waitForDiscordGatewayStopMock.mockImplementationOnce(async () => {
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
      expect(gateway.state).toBeDefined();
      expect(gateway.state?.sessionId).toBeNull();
      expect(gateway.state?.resumeGatewayUrl).toBeNull();
      expect(gateway.state?.sequence).toBeNull();
      expect(gateway.sequence).toBeNull();
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
      getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
      waitForDiscordGatewayStopMock.mockImplementationOnce(async () => {
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

      expect(gateway.connect).toHaveBeenCalledTimes(3);
      expect(gateway.connect).toHaveBeenNthCalledWith(1, true);
      expect(gateway.connect).toHaveBeenNthCalledWith(2, true);
      expect(gateway.connect).toHaveBeenNthCalledWith(3, true);
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
      getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
      waitForDiscordGatewayStopMock.mockImplementationOnce(
        (waitParams: WaitForDiscordGatewayStopParams) =>
          new Promise<void>((_resolve, reject) => {
            waitParams.registerForceStop?.((err) => reject(err));
          }),
      );
      const {
        lifecycleParams,
        runtimeError,
        releaseEarlyGatewayErrorGuard,
        start,
        statusSink,
        stop,
        threadStop,
      } = createLifecycleHarness({ gateway });

      const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);
      lifecyclePromise.catch(() => {});
      emitter.emit("debug", "WebSocket connection closed with code 1006");

      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
      await expect(lifecyclePromise).rejects.toThrow("reconnect watchdog timeout");
      expect(runtimeError).toHaveBeenCalledWith(
        expect.stringContaining(
          "discord: reconnect watchdog timeout: idle 300000ms (limit 300000ms); force-stopping monitor task",
        ),
      );
      const closePatch = statusSink.mock.calls.find((call) => {
        const patch = (call[0] ?? {}) as {
          connected?: boolean;
          lastDisconnect?: { status?: number };
        };
        return patch.connected === false && patch.lastDisconnect?.status === 1006;
      });
      expect(closePatch).toBeDefined();
      const watchdogPatch = statusSink.mock.calls.find((call) => {
        const patch = (call[0] ?? {}) as {
          connected?: boolean;
          lastError?: string;
          lastDisconnect?: { error?: string };
        };
        return (
          patch.connected === false &&
          patch.lastError ===
            "discord reconnect watchdog timeout: idle 300000ms (limit 300000ms)" &&
          patch.lastDisconnect?.error ===
            "discord reconnect watchdog timeout: idle 300000ms (limit 300000ms)"
        );
      });
      expect(watchdogPatch).toBeDefined();
      expectLifecycleCleanup({
        start,
        stop,
        threadStop,
        waitCalls: 1,
        releaseEarlyGatewayErrorGuard,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not force-stop when reconnect resumes before watchdog timeout", async () => {
    vi.useFakeTimers();
    try {
      const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
      const { emitter, gateway } = createGatewayHarness();
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

  it("does not push connected: true when abortSignal is already aborted", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    const emitter = new EventEmitter();
    const gateway = {
      isConnected: true,
      options: { reconnect: { maxAttempts: 3 } },
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
    expect(connectedFalse).toBeDefined();

    // No connected: true should appear — the isConnected check must be
    // guarded by !lifecycleStopping to avoid contradicting the abort.
    const connectedTrue = statusUpdates.find((s) => s.connected === true);
    expect(connectedTrue).toBeUndefined();
  });
});
