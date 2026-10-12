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
  replyMock,
  sendMock,
  signalRpcRequestMock,
  upsertPairingRequestMock,
  waitForTransportReadyMock,
  assertSignalDaemonEndpointAvailableMock,
  signalCheckMock,
  spawnSignalDaemonMock,
  streamMock,
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

function setSignalAutoStartConfig(overrides: Record<string, unknown> = {}) {
  setSignalToolResultTestConfig(createSignalToolResultConfig(overrides));
}

function createAutoAbortController() {
  const abortController = new AbortController();
  streamMock.mockImplementation(async () => {
    abortController.abort();
  });
  return abortController;
}

async function runMonitorWithMocks(opts: MonitorSignalProviderOptions) {
  return monitorSignalProvider({
    runtime: createMonitorRuntime(),
    ...opts,
  });
}

describe("monitorSignalProvider autostart", () => {
  beforeEach(() => setSignalAutoStartConfig());
  it("uses the configured private socket for startup, readiness, and receive without HTTP", async () => {
    setSignalAutoStartConfig({
      transport: {
        kind: "managed-native",
        socketPath: "/private/signal/rpc",
        configPath: "~/.openclaw/signal-cli",
      },
    });
    waitForTransportReadyMock.mockImplementationOnce(
      async ({ check }: { check: () => Promise<unknown> }) => {
        await check();
      },
    );
    const abortController = createAutoAbortController();
    await runMonitorWithMocks({
      abortSignal: abortController.signal,
    });
    expect(assertSignalDaemonEndpointAvailableMock).toHaveBeenCalledWith(
      expect.objectContaining({ socketPath: "/private/signal/rpc" }),
    );
    expect(spawnSignalDaemonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        socketPath: "/private/signal/rpc",
        configPath: "~/.openclaw/signal-cli",
      }),
    );
    expect(signalCheckMock).toHaveBeenCalledWith("unix:///private/signal/rpc", expect.any(Number));
    expect(streamMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "unix:///private/signal/rpc" }),
    );
  });

  it("binds a URL-only local HTTP port for both the daemon and the readiness probe", async () => {
    setSignalAutoStartConfig({
      transport: {
        kind: "managed-native",
        url: "http://127.0.0.1:8082",
      },
    });
    waitForTransportReadyMock.mockImplementationOnce(
      async ({ check }: { check: () => Promise<unknown> }) => {
        await check();
      },
    );
    const abortController = createAutoAbortController();
    await runMonitorWithMocks({
      abortSignal: abortController.signal,
    });
    expect(spawnSignalDaemonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        httpHost: "127.0.0.1",
        httpPort: 8082,
      }),
    );
    expect(signalCheckMock).toHaveBeenCalledWith("http://127.0.0.1:8082", expect.any(Number));
  });

  it("rewrites the daemon bind and readiness URL when a sibling reserves the URL port", async () => {
    setSignalAutoStartConfig({
      accounts: {
        sibling: {
          account: "+10000000001",
          transport: { kind: "external-native", url: "http://127.0.0.1:8082" },
        },
        managed: {
          account: "+10000000002",
          transport: { kind: "managed-native", url: "http://127.0.0.1:8082" },
        },
      },
    });
    let spawnedHost = "";
    let spawnedPort = 0;
    spawnSignalDaemonMock.mockImplementationOnce(
      (opts: { httpHost?: string; httpPort?: number }) => {
        spawnedHost = opts.httpHost ?? "";
        spawnedPort = opts.httpPort ?? 0;
        return createMockSignalDaemonHandle();
      },
    );
    waitForTransportReadyMock.mockImplementationOnce(
      async ({ check }: { check: () => Promise<unknown> }) => {
        await check();
      },
    );
    const abortController = createAutoAbortController();
    await runMonitorWithMocks({
      abortSignal: abortController.signal,
      accountId: "managed",
    });
    expect(spawnedPort).not.toBe(8082);
    expect(signalCheckMock).toHaveBeenCalledWith(
      `http://${spawnedHost}:${spawnedPort}`,
      expect.any(Number),
    );
  });

  it("refuses HTTP overrides for an opted-in private transport", async () => {
    setSignalAutoStartConfig({
      transport: { kind: "managed-native", socketPath: "/private/signal/rpc" },
    });
    await expect(runMonitorWithMocks({ baseUrl: SIGNAL_BASE_URL })).rejects.toThrow(
      "cannot be combined with HTTP endpoint overrides",
    );
    expect(spawnSignalDaemonMock).not.toHaveBeenCalled();
  });
  it("normalizes an IPv6 override and reports an occupied endpoint before spawning", async () => {
    const abortController = createAutoAbortController();
    setSignalAutoStartConfig({ httpPort: 8181 });
    assertSignalDaemonEndpointAvailableMock.mockRejectedValueOnce(
      new Error("Signal managed native endpoint ::1:8181 is already in use."),
    );

    await expect(
      runMonitorWithMocks({
        abortSignal: abortController.signal,
        httpHost: "[::1]",
      }),
    ).rejects.toThrow("Signal managed native endpoint ::1:8181 is already in use.");
    expect(assertSignalDaemonEndpointAvailableMock).toHaveBeenCalledWith(
      expect.objectContaining({
        httpHost: "::1",
        httpPort: 8181,
        abortSignal: expect.any(AbortSignal),
      }),
    );
    expect(spawnSignalDaemonMock).not.toHaveBeenCalled();
    expect(waitForTransportReadyMock).not.toHaveBeenCalled();
  });

  it("cancels the managed endpoint probe when monitoring aborts", async () => {
    const abortController = new AbortController();
    const started = Promise.withResolvers<void>();
    assertSignalDaemonEndpointAvailableMock.mockImplementationOnce(
      ({ abortSignal }: { abortSignal: AbortSignal }) => {
        started.resolve();
        return rejectOnAbort(abortSignal);
      },
    );

    const monitorPromise = runMonitorWithMocks({
      abortSignal: abortController.signal,
    });
    await started.promise;
    abortController.abort();

    await expect(monitorPromise).resolves.toBeUndefined();
    expect(spawnSignalDaemonMock).not.toHaveBeenCalled();
  });

  it("does not spawn when monitoring aborts as the endpoint probe completes", async () => {
    const abortController = new AbortController();
    assertSignalDaemonEndpointAvailableMock.mockImplementationOnce(async () => {
      abortController.abort();
    });

    await expect(
      runMonitorWithMocks({
        abortSignal: abortController.signal,
      }),
    ).resolves.toBeUndefined();
    expect(spawnSignalDaemonMock).not.toHaveBeenCalled();
  });

  it("bounds the managed endpoint probe by the startup timeout", async () => {
    assertSignalDaemonEndpointAvailableMock.mockImplementationOnce(
      ({ abortSignal }: { abortSignal: AbortSignal }) => rejectOnAbort(abortSignal),
    );

    await expect(
      runMonitorWithMocks({
        startupTimeoutMs: 1_000,
      }),
    ).rejects.toThrow("signal daemon startup timed out after 1000ms while checking its endpoint");
    expect(spawnSignalDaemonMock).not.toHaveBeenCalled();
  });

  it("does not spawn when the endpoint probe consumes the startup deadline", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    assertSignalDaemonEndpointAvailableMock.mockImplementationOnce(async () => {
      now.mockReturnValue(2_000);
    });

    try {
      await expect(
        runMonitorWithMocks({
          startupTimeoutMs: 1_000,
        }),
      ).rejects.toThrow("signal daemon startup timed out after 1000ms before starting");
      expect(spawnSignalDaemonMock).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it("bounds the final readiness request by the shared startup deadline", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const abortController = createAutoAbortController();
    assertSignalDaemonEndpointAvailableMock.mockImplementationOnce(async () => {
      now.mockReturnValue(1_900);
    });
    signalCheckMock.mockImplementationOnce(async () => {
      now.mockReturnValue(2_001);
      return { ok: true };
    });
    let readinessResult: unknown;
    waitForTransportReadyMock.mockImplementationOnce(
      async ({ check }: { check: () => Promise<unknown> }) => {
        readinessResult = await check();
      },
    );

    try {
      await runMonitorWithMocks({
        abortSignal: abortController.signal,
        startupTimeoutMs: 1_000,
      });
      expect(signalCheckMock).toHaveBeenCalledWith(SIGNAL_BASE_URL, 100);
      expect(readinessResult).toEqual({ ok: false, error: "startup deadline exceeded" });
    } finally {
      now.mockRestore();
    }
  });

  it("fails fast when auto-started signal daemon exits during startup", async () => {
    const statusSink = vi.fn();
    spawnSignalDaemonMock.mockReturnValueOnce(
      createMockSignalDaemonHandle({
        exited: Promise.resolve({ source: "process", code: 1, signal: null }),
      }),
    );
    waitForTransportReadyMock.mockImplementationOnce(
      ({ abortSignal }: { abortSignal?: AbortSignal | null }) => rejectOnAbort(abortSignal),
    );

    await expect(
      runMonitorWithMocks({
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
    spawnSignalDaemonMock.mockReturnValueOnce(
      createMockSignalDaemonHandle({
        exited: exited.promise,
        stop: vi.fn(() => {
          exited.resolve({ source: "process", code: null, signal: "SIGTERM" });
          stopStarted.resolve();
          return stopped.promise;
        }),
      }),
    );
    streamMock.mockImplementationOnce(async () => {
      abortController.abort(new Error("stop"));
    });
    // onAbort starts stop before ingress teardown has joined its rejection.
    void stopped.promise.catch(() => undefined);
    const stopError = new Error("daemon stop failed");
    const outcome = runMonitorWithMocks({ abortSignal: abortController.signal }).then(
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

function receiveEvent(message: string) {
  return {
    event: "receive",
    data: JSON.stringify({
      envelope: {
        sourceNumber: "+15550001111",
        sourceName: "Ada",
        timestamp: 1,
        dataMessage: { message },
      },
    }),
  };
}

describe("monitorSignalProvider tool results", () => {
  it("pairs UUID-only senders once while their pairing request remains pending", async () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    setSignalToolResultTestConfig(
      createSignalToolResultConfig({ autoStart: false, dmPolicy: "pairing", allowFrom: [] }),
    );
    upsertPairingRequestMock
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
    expect(replyMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalledTimes(2);
    expect(upsertPairingRequestMock).toHaveBeenCalledWith({
      channel: "signal",
      id: `uuid:${uuid}`,
      accountId: "default",
      meta: { name: "Ada" },
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[0]).toBe(`signal:${uuid}`);
    expectPairingReplyText(String(sendMock.mock.calls[0]?.[1] ?? ""), {
      channel: "signal",
      idLine: `Your Signal sender id: uuid:${uuid}`,
      code: "PAIRCODE",
    });
  });

  it("reconnects after stream errors until aborted", async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    streamMock
      .mockRejectedValueOnce(new Error("stream dropped"))
      .mockImplementationOnce(async () => {
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

      expect(streamMock).toHaveBeenCalledTimes(2);
      expect(streamMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ timeoutMs: 0 }));
      expect(streamMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ timeoutMs: 0 }));
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
    replyMock.mockResolvedValue({ text: "accepted reply" });
    sendMock.mockImplementation(async () => {
      sendStarted.resolve();
      await sendCompleted.promise;
    });
    streamMock.mockImplementation(async ({ onEvent, abortSignal }) => {
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

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith("+15550001111", "accepted reply", expect.anything());
  });

  it("does not dispatch a buffered inbound message after the monitor stops", async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    setSignalToolResultTestConfig({
      messages: { inbound: { debounceMs: 10 } },
      channels: { signal: { autoStart: false, dmPolicy: "open", allowFrom: ["*"] } },
    });
    replyMock.mockResolvedValue({ text: "late reply" });
    streamMock.mockImplementation(async ({ onEvent }) => {
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

      expect(replyMock).not.toHaveBeenCalled();
      expect(sendMock).not.toHaveBeenCalled();
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

    replyMock.mockResolvedValue({ text: "ok" });
    signalRpcRequestMock.mockResolvedValue({ data: Buffer.from("hello").toString("base64") });
    await receiveSignalPayloads({
      opts: { mediaMaxMb: 2, baseUrl: undefined },
      payloads: [
        {
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1,
            dataMessage: {
              message: "",
              attachments: [{ id: "attachment-1", size: 1_500_000, contentType: "text/plain" }],
            },
          },
        },
      ],
    });

    expect(signalRpcRequestMock).toHaveBeenCalledWith(
      "getAttachment",
      {
        id: "attachment-1",
        recipient: "+15550001111",
      },
      {
        baseUrl: "http://container:8080",
        timeoutMs: undefined,
        transportKind: "container",
        maxResponseBytes: expectedMaxResponseBytes,
      },
    );
  });
});
