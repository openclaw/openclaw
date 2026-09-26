// Signal tests cover monitor shutdown when ingress stop waits on a hung reply.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  config,
  createMockSignalDaemonHandle,
  createSignalToolResultConfig,
  getSignalToolResultIngressQueue,
  getSignalToolResultTestMocks,
  installSignalToolResultTestHooks,
  setSignalToolResultTestConfig,
} from "./monitor.tool-result.test-harness.js";

installSignalToolResultTestHooks();
const { monitorSignalProvider } = await import("./monitor.js");

const { replyMock, sendMock, signalRpcRequestMock, spawnSignalDaemonMock, streamMock } =
  getSignalToolResultTestMocks();

const WAIT_FOR_IDLE_TIMEOUT_MS = 30_000;

function createMonitorRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: ((code: number): never => {
      throw new Error(`exit ${code}`);
    }) as (code: number) => never,
  };
}

describe("monitorSignalProvider hung-receive shutdown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns after the idle window when ingress stop waits on a hung reply", async () => {
    const abortController = new AbortController();
    const runtime = createMonitorRuntime();
    let resolveReply: ((value: { text: string }) => void) | undefined;
    replyMock.mockImplementation(
      () =>
        new Promise<{ text: string }>((resolve) => {
          resolveReply = resolve;
        }),
    );
    streamMock.mockImplementation(async ({ onEvent, abortSignal }) => {
      await onEvent({
        event: "receive",
        data: JSON.stringify({
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1,
            dataMessage: { message: "accepted before stop" },
          },
        }),
      });
      await new Promise<void>((resolve) => {
        abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
    });

    const monitorPromise = monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
      config: config as OpenClawConfig,
      runtime,
    });
    await vi.waitFor(() => expect(replyMock).toHaveBeenCalledTimes(1));

    vi.useFakeTimers();
    abortController.abort(new Error("monitor stopped"));
    await vi.advanceTimersByTimeAsync(WAIT_FOR_IDLE_TIMEOUT_MS);

    let returned = false;
    const returnedPromise = monitorPromise.then(() => {
      returned = true;
    });
    await Promise.resolve();
    expect(returned).toBe(true);
    await returnedPromise;

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining(`${WAIT_FOR_IDLE_TIMEOUT_MS}ms`),
    );
    expect(sendMock).not.toHaveBeenCalled();

    vi.useRealTimers();
    if (!resolveReply) {
      throw new Error("expected hung reply resolver");
    }
    resolveReply({ text: "late reply after retirement" });
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    expect(sendMock).toHaveBeenCalledWith(
      "+15550001111",
      "PFX late reply after retirement",
      expect.anything(),
    );
  });

  it("keeps an accepted hung attachment claim when teardown hits the idle window", async () => {
    const abortController = new AbortController();
    const runtime = createMonitorRuntime();
    signalRpcRequestMock.mockImplementation(() => new Promise(() => {}));
    streamMock.mockImplementation(async ({ onEvent, abortSignal }) => {
      await onEvent({
        event: "receive",
        data: JSON.stringify({
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1,
            dataMessage: {
              message: "",
              attachments: [{ id: "attachment-1", size: 12, contentType: "text/plain" }],
            },
          },
        }),
      });
      await new Promise<void>((resolve) => {
        abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
    });

    const monitorPromise = monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
      config: config as OpenClawConfig,
      runtime,
    });
    await vi.waitFor(() => expect(signalRpcRequestMock).toHaveBeenCalled());

    const queue = getSignalToolResultIngressQueue();
    if (!queue) {
      throw new Error("expected Signal ingress queue");
    }
    const claimedBeforeStop = await queue.listClaims();
    expect(claimedBeforeStop.length).toBeGreaterThan(0);

    vi.useFakeTimers();
    abortController.abort(new Error("monitor stopped"));
    await vi.advanceTimersByTimeAsync(WAIT_FOR_IDLE_TIMEOUT_MS);

    let returned = false;
    const returnedPromise = monitorPromise.then(() => {
      returned = true;
    });
    await Promise.resolve();
    expect(returned).toBe(true);
    await returnedPromise;

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining(`${WAIT_FOR_IDLE_TIMEOUT_MS}ms`),
    );
    const claimedAfterReturn = await queue.listClaims();
    expect(claimedAfterReturn.map((claim) => claim.id)).toEqual(
      claimedBeforeStop.map((claim) => claim.id),
    );
  });

  it("does not complete while managed daemon stop is still unresolved", async () => {
    setSignalToolResultTestConfig(createSignalToolResultConfig());
    const abortController = new AbortController();
    const runtime = createMonitorRuntime();
    let resolveDaemonStop: (() => void) | undefined;
    spawnSignalDaemonMock.mockReturnValue(
      createMockSignalDaemonHandle({
        stop: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              resolveDaemonStop = resolve;
            }),
        ),
      }),
    );
    streamMock.mockImplementation(async () => {
      abortController.abort(new Error("monitor stopped"));
    });

    const monitorPromise = monitorSignalProvider({
      autoStart: true,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
      config: config as OpenClawConfig,
      runtime,
    });
    await vi.waitFor(() => expect(resolveDaemonStop).toBeDefined());

    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(WAIT_FOR_IDLE_TIMEOUT_MS);
    let returned = false;
    const returnedPromise = monitorPromise.then(() => {
      returned = true;
    });
    await Promise.resolve();
    expect(returned).toBe(false);
    expect(runtime.error).not.toHaveBeenCalled();

    vi.useRealTimers();
    if (!resolveDaemonStop) {
      throw new Error("expected managed daemon stop to start");
    }
    resolveDaemonStop();
    await returnedPromise;
    expect(returned).toBe(true);
  });
});
