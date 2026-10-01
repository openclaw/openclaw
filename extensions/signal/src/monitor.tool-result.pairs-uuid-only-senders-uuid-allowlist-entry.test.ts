import { Buffer } from "node:buffer";
import * as timers from "node:timers/promises";
import { expectPairingReplyText } from "openclaw/plugin-sdk/channel-test-helpers";
import { waitForAbortSignal } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it, vi } from "vitest";
import {
  createSignalToolResultConfig,
  getSignalToolResultTestMocks,
  installSignalToolResultTestHooks,
  setSignalToolResultTestConfig,
  receiveSignalPayloads,
} from "./monitor.tool-result.test-harness.js";

installSignalToolResultTestHooks();
vi.mock("node:timers/promises", { spy: true });
const nativeTimers =
  await vi.importActual<typeof import("node:timers/promises")>("node:timers/promises");
const { monitorSignalProvider } = await import("./monitor.js");

const { replyMock, sendMock, streamMock, signalRpcRequestMock, upsertPairingRequestMock } =
  getSignalToolResultTestMocks();

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
      onEvent(receiveEvent("hello after the prior turn"));
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
