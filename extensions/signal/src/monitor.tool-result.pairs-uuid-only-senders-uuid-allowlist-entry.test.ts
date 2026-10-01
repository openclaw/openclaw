import { Buffer } from "node:buffer";
import * as timers from "node:timers/promises";
import { waitForAbortSignal } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it, vi } from "vitest";
import {
  config,
  getSignalToolResultTestMocks,
  installSignalToolResultTestHooks,
  setSignalToolResultTestConfig,
  toSignalToolResultTestError,
  waitForSignalToolResultIngressIdle,
} from "./monitor.tool-result.test-harness.js";

installSignalToolResultTestHooks();
vi.mock("node:timers/promises", { spy: true });
const nativeTimers =
  await vi.importActual<typeof import("node:timers/promises")>("node:timers/promises");
const { monitorSignalProvider } = await import("./monitor.js");

const { replyMock, sendMock, streamMock, signalRpcRequestMock, upsertPairingRequestMock } =
  getSignalToolResultTestMocks();

type MonitorSignalProviderOptions = Parameters<typeof monitorSignalProvider>[0];

async function runMonitorWithMocks(opts: MonitorSignalProviderOptions) {
  return monitorSignalProvider(opts);
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call.at(argIndex);
}

describe("monitorSignalProvider tool results", () => {
  it("pairs uuid-only senders with a uuid allowlist entry", async () => {
    const baseChannels = (config.channels ?? {}) as Record<string, unknown>;
    const baseSignal = (baseChannels.signal ?? {}) as Record<string, unknown>;
    setSignalToolResultTestConfig({
      ...config,
      channels: {
        ...baseChannels,
        signal: {
          ...baseSignal,
          autoStart: false,
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    });
    const abortController = new AbortController();
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    let ingressError: Error | undefined;

    streamMock.mockImplementation(async ({ onEvent }) => {
      const payload = {
        envelope: {
          sourceUuid: uuid,
          sourceName: "Ada",
          timestamp: 1,
          dataMessage: {
            message: "hello",
          },
        },
      };
      try {
        await onEvent({
          event: "receive",
          data: JSON.stringify(payload),
        });
        await waitForSignalToolResultIngressIdle();
      } catch (error) {
        ingressError = toSignalToolResultTestError(error, "Signal ingress delivery failed");
      } finally {
        abortController.abort();
      }
    });

    await runMonitorWithMocks({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
    });
    if (ingressError) {
      throw ingressError;
    }

    expect(replyMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalledWith({
      channel: "signal",
      id: `uuid:${uuid}`,
      accountId: "default",
      meta: { name: "Ada" },
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(mockCallArg(sendMock)).toBe(`signal:${uuid}`);
    const pairingReply = mockCallArg(sendMock, 0, 1);
    if (typeof pairingReply !== "string") {
      throw new Error("Expected pairing reply text");
    }
    expect(pairingReply).toContain(`Your Signal sender id: uuid:${uuid}`);
  });

  it("reconnects after stream errors until aborted", async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    let calls = 0;

    streamMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("stream dropped");
      }
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
      expect((mockCallArg(streamMock) as { timeoutMs?: unknown }).timeoutMs).toBe(0);
      expect((mockCallArg(streamMock, 1) as { timeoutMs?: unknown }).timeoutMs).toBe(0);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("cancels a pending reply-session conflict retry when the monitor stops", async ({
    signal,
  }) => {
    const abortController = new AbortController();
    const retryStarted = Promise.withResolvers<AbortSignal | undefined>();
    let releaseRetry: (() => void) | undefined;
    let retryAborted = false;
    const onTestAbort = () => {
      retryStarted.reject(new Error("Test stopped before retry", { cause: signal.reason }));
      releaseRetry?.();
    };
    signal.addEventListener("abort", onTestAbort, { once: true });
    const sleep = vi.mocked(timers.setTimeout).mockImplementation((delay, value, options) => {
      if (replyMock.mock.calls.length === 0 || options?.ref !== false) {
        return nativeTimers.setTimeout(delay, value, options);
      }
      const retrySignal = options.signal;
      retryStarted.resolve(retrySignal);
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          retryAborted = true;
          reject(new Error("retry cancelled", { cause: retrySignal?.reason }));
        };
        releaseRetry = () => {
          retrySignal?.removeEventListener("abort", onAbort);
          resolve(value);
        };
        retrySignal?.addEventListener("abort", onAbort, { once: true });
        if (retrySignal?.aborted) {
          onAbort();
        }
      });
    });
    replyMock.mockRejectedValue(
      new Error(
        "reply session initialization conflicted for agent:main:signal:direct:+15550001111",
      ),
    );
    streamMock.mockImplementation(async ({ onEvent, abortSignal }) => {
      onEvent({
        event: "receive",
        data: JSON.stringify({
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1,
            dataMessage: { message: "hello after the prior turn" },
          },
        }),
      });
      await waitForAbortSignal(abortSignal);
    });

    const monitorPromise = monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: AbortSignal.any([abortController.signal, signal]),
    });
    try {
      const retrySignal = await Promise.race([
        retryStarted.promise,
        monitorPromise.then(() => {
          throw new Error("Signal monitor stopped before scheduling its retry");
        }),
      ]);
      expect(replyMock).toHaveBeenCalledTimes(1);
      expect(retrySignal?.aborted).toBe(false);
      abortController.abort(new Error("monitor stopped"));
      await monitorPromise;
      expect(retryAborted).toBe(true);
      expect(replyMock).toHaveBeenCalledTimes(1);
    } finally {
      abortController.abort(new Error("monitor stopped"));
      signal.removeEventListener("abort", onTestAbort);
      releaseRetry?.();
      try {
        await monitorPromise;
      } finally {
        sleep.mockImplementation(nativeTimers.setTimeout);
      }
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
      onEvent({
        event: "receive",
        data: JSON.stringify({
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1,
            dataMessage: { message: "accepted message" },
          },
        }),
      });
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
      onEvent({
        event: "receive",
        data: JSON.stringify({
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1,
            dataMessage: { message: "wait for more" },
          },
        }),
      });
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
    const abortController = new AbortController();
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
    streamMock.mockImplementation(async ({ onEvent }) => {
      await onEvent({
        event: "receive",
        data: JSON.stringify({
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1,
            dataMessage: {
              message: "",
              attachments: [{ id: "attachment-1", size: 1_500_000, contentType: "text/plain" }],
            },
          },
        }),
      });
      await waitForSignalToolResultIngressIdle();
      abortController.abort();
    });

    await monitorSignalProvider({
      mediaMaxMb: 2,
      abortSignal: abortController.signal,
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
