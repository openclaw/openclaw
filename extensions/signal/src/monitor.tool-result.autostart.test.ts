import { Buffer } from "node:buffer";
import { expectPairingReplyText } from "openclaw/plugin-sdk/channel-test-helpers";
import { toErrorObject as toLintErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { waitForAbortSignal } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalDaemonHandle } from "./daemon.js";
import {
  createSignalToolResultConfig,
  receiveSignalPayloads,
  createMockSignalDaemonHandle,
  getSignalToolResultTestMocks,
  installSignalToolResultTestHooks,
  setSignalToolResultTestConfig,
} from "./monitor.tool-result.test-harness.js";

installSignalToolResultTestHooks();

const { monitorSignalProvider } = await import("./monitor.js");

const {
  replyMock: reply,
  sendMock: send,
  signalRpcRequestMock: rpc,
  upsertPairingRequestMock: pair,
  waitForTransportReadyMock: waitUntilReady,
  assertSignalDaemonEndpointAvailableMock: probeEndpoint,
  signalCheckMock: checkSignal,
  spawnSignalDaemonMock: spawnDaemon,
  streamMock: stream,
} = getSignalToolResultTestMocks();

const SIGNAL_BASE_URL = "http://127.0.0.1:8080";
type MonitorSignalProviderOptions = NonNullable<Parameters<typeof monitorSignalProvider>[0]>;

async function rejectOnAbort(abortSignal?: AbortSignal | null) {
  await waitForAbortSignal(abortSignal ?? undefined);
  throw toLintErrorObject(abortSignal?.reason ?? new Error("aborted"), "Non-Error rejection");
}

function createMonitorRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };
}

function configure(overrides: Record<string, unknown> = {}) {
  setSignalToolResultTestConfig(createSignalToolResultConfig(overrides));
}

function createAutoAbortController() {
  const abortController = new AbortController();
  stream.mockImplementation(async () => {
    abortController.abort();
  });
  return abortController;
}

async function runMonitor(opts: MonitorSignalProviderOptions) {
  return monitorSignalProvider({
    runtime: createMonitorRuntime(),
    ...opts,
  });
}

describe("monitorSignalProvider autostart", () => {
  beforeEach(() => configure());
  it("uses the configured private socket for startup, readiness, and receive without HTTP", async () => {
    configure({
      transport: {
        kind: "managed-native",
        socketPath: "/private/signal/rpc",
        configPath: "~/.openclaw/signal-cli",
      },
    });
    waitUntilReady.mockImplementationOnce(async ({ check }: { check: () => Promise<unknown> }) => {
      await check();
    });
    const abortController = createAutoAbortController();
    await runMonitor({ abortSignal: abortController.signal });
    expect(probeEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ socketPath: "/private/signal/rpc" }),
    );
    expect(spawnDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        socketPath: "/private/signal/rpc",
        configPath: "~/.openclaw/signal-cli",
      }),
    );
    expect(checkSignal).toHaveBeenCalledWith("unix:///private/signal/rpc", expect.any(Number));
    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "unix:///private/signal/rpc" }),
    );
  });

  it("refuses HTTP overrides for an opted-in private transport", async () => {
    configure({
      transport: { kind: "managed-native", socketPath: "/private/signal/rpc" },
    });
    await expect(runMonitor({ baseUrl: SIGNAL_BASE_URL })).rejects.toThrow(
      "cannot be combined with HTTP endpoint overrides",
    );
    expect(spawnDaemon).not.toHaveBeenCalled();
  });
  it("normalizes an IPv6 override and reports an occupied endpoint before spawning", async () => {
    const abortController = createAutoAbortController();
    configure({ httpPort: 8181 });
    probeEndpoint.mockRejectedValueOnce(
      new Error("Signal managed native endpoint ::1:8181 is already in use."),
    );
    await expect(
      runMonitor({ abortSignal: abortController.signal, httpHost: "[::1]" }),
    ).rejects.toThrow("Signal managed native endpoint ::1:8181 is already in use.");
    expect(probeEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        httpHost: "::1",
        httpPort: 8181,
        abortSignal: expect.any(AbortSignal),
      }),
    );
    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(waitUntilReady).not.toHaveBeenCalled();
  });

  it("cancels the managed endpoint probe when monitoring aborts", async () => {
    const abortController = new AbortController();
    const started = Promise.withResolvers<void>();
    probeEndpoint.mockImplementationOnce(({ abortSignal }: { abortSignal: AbortSignal }) => {
      started.resolve();
      return rejectOnAbort(abortSignal);
    });
    const monitorPromise = runMonitor({ abortSignal: abortController.signal });
    await started.promise;
    abortController.abort();
    await expect(monitorPromise).resolves.toBeUndefined();
    expect(spawnDaemon).not.toHaveBeenCalled();
  });

  it("does not spawn when monitoring aborts as the endpoint probe completes", async () => {
    const abortController = new AbortController();
    probeEndpoint.mockImplementationOnce(async () => {
      abortController.abort();
    });
    await expect(runMonitor({ abortSignal: abortController.signal })).resolves.toBeUndefined();
    expect(spawnDaemon).not.toHaveBeenCalled();
  });

  it("bounds the managed endpoint probe by the startup timeout", async () => {
    probeEndpoint.mockImplementationOnce(({ abortSignal }: { abortSignal: AbortSignal }) =>
      rejectOnAbort(abortSignal),
    );
    await expect(runMonitor({ startupTimeoutMs: 1_000 })).rejects.toThrow(
      "signal daemon startup timed out after 1000ms while checking its endpoint",
    );
    expect(spawnDaemon).not.toHaveBeenCalled();
  });

  it("does not spawn when the endpoint probe consumes the startup deadline", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    probeEndpoint.mockImplementationOnce(async () => {
      now.mockReturnValue(2_000);
    });
    try {
      await expect(runMonitor({ startupTimeoutMs: 1_000 })).rejects.toThrow(
        "signal daemon startup timed out after 1000ms before starting",
      );
      expect(spawnDaemon).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it("bounds the final readiness request by the shared startup deadline", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const abortController = createAutoAbortController();
    probeEndpoint.mockImplementationOnce(async () => {
      now.mockReturnValue(1_900);
    });
    checkSignal.mockImplementationOnce(async () => {
      now.mockReturnValue(2_001);
      return { ok: true };
    });
    let readinessResult: unknown;
    waitUntilReady.mockImplementationOnce(async ({ check }: { check: () => Promise<unknown> }) => {
      readinessResult = await check();
    });
    try {
      await runMonitor({ abortSignal: abortController.signal, startupTimeoutMs: 1_000 });
      expect(checkSignal).toHaveBeenCalledWith(SIGNAL_BASE_URL, 100);
      expect(readinessResult).toEqual({ ok: false, error: "startup deadline exceeded" });
    } finally {
      now.mockRestore();
    }
  });

  it("fails fast when auto-started signal daemon exits during startup", async () => {
    const statusSink = vi.fn();
    spawnDaemon.mockReturnValueOnce(
      createMockSignalDaemonHandle({
        exited: Promise.resolve({ source: "process", code: 1, signal: null }),
      }),
    );
    waitUntilReady.mockImplementationOnce(({ abortSignal }: { abortSignal?: AbortSignal | null }) =>
      rejectOnAbort(abortSignal),
    );
    await expect(
      runMonitor({
        autoStart: true,
        baseUrl: SIGNAL_BASE_URL,
        statusSink,
      }),
    ).rejects.toThrow(/signal daemon exited/i);
    expect(statusSink).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: "recovering", connected: false }),
    );
  });

  it.each([false, true])("joins daemon shutdown, including stop failure=%s", async (rejectStop) => {
    const abortController = new AbortController();
    const exited = Promise.withResolvers<Awaited<SignalDaemonHandle["exited"]>>();
    const stopped = Promise.withResolvers<void>();
    const stopStarted = Promise.withResolvers<void>();
    spawnDaemon.mockReturnValueOnce(
      createMockSignalDaemonHandle({
        exited: exited.promise,
        stop: vi.fn(() => {
          exited.resolve({ source: "process", code: null, signal: "SIGTERM" });
          stopStarted.resolve();
          return stopped.promise;
        }),
      }),
    );
    stream.mockImplementationOnce(async () => {
      abortController.abort(new Error("stop"));
    });
    // onAbort starts stop before ingress teardown has joined its rejection.
    void stopped.promise.catch(() => undefined);
    const stopError = new Error("daemon stop failed");
    const outcome = runMonitor({ abortSignal: abortController.signal }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await stopStarted.promise;
    if (rejectStop) {
      stopped.reject(stopError);
    } else {
      stopped.resolve();
    }
    expect(await outcome).toBe(rejectStop ? stopError : undefined);
  });
});

function inboundPayload(dataMessage: Record<string, unknown>) {
  return {
    envelope: { sourceNumber: "+15550001111", sourceName: "Ada", timestamp: 1, dataMessage },
  };
}

function receiveEvent(message: string) {
  return {
    event: "receive",
    data: JSON.stringify(inboundPayload({ message })),
  };
}

describe("monitorSignalProvider tool results", () => {
  it("pairs UUID-only senders once while their pairing request remains pending", async () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    setSignalToolResultTestConfig(
      createSignalToolResultConfig({ autoStart: false, dmPolicy: "pairing", allowFrom: [] }),
    );
    pair
      .mockResolvedValueOnce({ code: "PAIRCODE", created: true })
      .mockResolvedValueOnce({ code: "PAIRCODE", created: false });
    await receiveSignalPayloads({
      payloads: [1, 2].map((timestamp) => ({
        envelope: {
          sourceUuid: uuid,
          sourceName: "Ada",
          timestamp,
          dataMessage: { message: "hello" },
        },
      })),
    });
    expect(reply).not.toHaveBeenCalled();
    expect(pair).toHaveBeenCalledTimes(2);
    expect(pair).toHaveBeenCalledWith({
      channel: "signal",
      id: `uuid:${uuid}`,
      accountId: "default",
      meta: { name: "Ada" },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe(`signal:${uuid}`);
    expectPairingReplyText(String(send.mock.calls[0]?.[1] ?? ""), {
      channel: "signal",
      idLine: `Your Signal sender id: uuid:${uuid}`,
      code: "PAIRCODE",
    });
  });

  it("reconnects after stream errors until aborted", async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    stream.mockRejectedValueOnce(new Error("stream dropped")).mockImplementationOnce(async () => {
      abortController.abort();
    });
    try {
      const monitorPromise = monitorSignalProvider({
        autoStart: false,
        baseUrl: "http://127.0.0.1:8080",
        abortSignal: abortController.signal,
        reconnectPolicy: {
          initialMs: 1,
          maxMs: 1,
          factor: 1,
          jitter: 0,
        },
      });

      await vi.advanceTimersByTimeAsync(5);
      await monitorPromise;

      expect(stream).toHaveBeenCalledTimes(2);
      expect(stream).toHaveBeenNthCalledWith(1, expect.objectContaining({ timeoutMs: 0 }));
      expect(stream).toHaveBeenNthCalledWith(2, expect.objectContaining({ timeoutMs: 0 }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains an inline inbound message accepted before the monitor stops", async ({ signal }) => {
    const abortController = new AbortController();
    const sendStarted = Promise.withResolvers<void>();
    const sendCompleted = Promise.withResolvers<void>();
    setSignalToolResultTestConfig({
      messages: { visibleReplies: "automatic" },
      channels: { signal: { autoStart: false, dmPolicy: "open", allowFrom: ["*"] } },
    });
    reply.mockResolvedValue({ text: "accepted reply" });
    send.mockImplementation(async () => {
      sendStarted.resolve();
      await sendCompleted.promise;
    });
    stream.mockImplementation(async ({ onEvent, abortSignal }) => {
      onEvent(receiveEvent("accepted message"));
      await waitForAbortSignal(abortSignal);
    });
    const monitorPromise = monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: AbortSignal.any([abortController.signal, signal]),
    });
    try {
      await Promise.race([
        sendStarted.promise,
        monitorPromise.then(() => {
          throw new Error("Signal monitor stopped before delivering the accepted reply");
        }),
      ]);
      abortController.abort(new Error("monitor stopped"));
    } finally {
      abortController.abort(new Error("monitor stopped"));
      sendCompleted.resolve();
      await monitorPromise;
    }
    expect(reply).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("+15550001111", "accepted reply", expect.anything());
  });

  it("does not dispatch a buffered inbound message after the monitor stops", async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    setSignalToolResultTestConfig({
      messages: { inbound: { debounceMs: 10 } },
      channels: { signal: { autoStart: false, dmPolicy: "open", allowFrom: ["*"] } },
    });
    reply.mockResolvedValue({ text: "late reply" });
    stream.mockImplementation(async ({ onEvent }) => {
      onEvent(receiveEvent("wait for more"));
      abortController.abort(new Error("monitor stopped"));
    });
    try {
      await monitorSignalProvider({
        autoStart: false,
        baseUrl: "http://127.0.0.1:8080",
        abortSignal: abortController.signal,
      });
      await vi.advanceTimersByTimeAsync(10);

      expect(reply).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sizes attachment RPC response caps from mediaMaxMb", async () => {
    const maxBytes = 2 * 1024 * 1024;
    const expectedMaxResponseBytes = Math.ceil((maxBytes * 4) / 3) + 64 * 1024;
    setSignalToolResultTestConfig({
      messages: { visibleReplies: "automatic" },
      channels: {
        signal: {
          transport: { kind: "container", url: "http://container:8080" },
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });
    reply.mockResolvedValue({ text: "ok" });
    rpc.mockResolvedValue({ data: Buffer.from("hello").toString("base64") });
    await receiveSignalPayloads({
      opts: { mediaMaxMb: 2, baseUrl: undefined },
      payloads: [
        inboundPayload({
          message: "",
          attachments: [{ id: "attachment-1", size: 1_500_000, contentType: "text/plain" }],
        }),
      ],
    });
    expect(rpc).toHaveBeenCalledWith(
      "getAttachment",
      { id: "attachment-1", recipient: "+15550001111" },
      {
        baseUrl: "http://container:8080",
        timeoutMs: undefined,
        transportKind: "container",
        maxResponseBytes: expectedMaxResponseBytes,
      },
    );
  });
});
