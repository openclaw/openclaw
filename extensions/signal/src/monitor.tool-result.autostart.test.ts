import { toErrorObject as toLintErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { waitForAbortSignal } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalDaemonHandle } from "./daemon.js";
import {
  createSignalToolResultConfig,
  createMockSignalDaemonHandle,
  getSignalToolResultTestMocks,
  installSignalToolResultTestHooks,
  setSignalToolResultTestConfig,
} from "./monitor.tool-result.test-harness.js";

installSignalToolResultTestHooks();

const { monitorSignalProvider } = await import("./monitor.js");

const {
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
        isExited: () => true,
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
