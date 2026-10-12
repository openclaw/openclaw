import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import {
  createTypingController,
  createTypingSignaler,
} from "openclaw/plugin-sdk/reply-payload-testing";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { createNonExitingRuntime } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSignalToolResultConfig,
  getSignalToolResultTestMocks,
  installSignalToolResultTestHooks,
  receiveSignalPayloads,
  setSignalToolResultTestConfig,
} from "./monitor.tool-result.test-harness.js";

installSignalToolResultTestHooks();

const logVerboseMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  logVerbose: logVerboseMock,
}));

// Keep the real provider encoding and mock only its external RPC boundary.
const { sendTypingSignal } = await import("./send.js");
const actualSend = await vi.importActual<typeof import("./send.js")>("./send.js");
const { replyMock, sendMock, signalRpcRequestMock } = getSignalToolResultTestMocks();

const account = "+15550009999";
const recipient = "+15550001111";
const baseUrl = "http://127.0.0.1:8080";
const accountId = "work";

function incomingMessage(sourceNumber = recipient, groupId?: string) {
  return {
    envelope: {
      sourceNumber,
      sourceName: "Ada",
      timestamp: 1700000000001,
      dataMessage: {
        message: "hello",
        ...(groupId ? { groupInfo: { groupId, groupName: "Test group" } } : {}),
      },
    },
  };
}

function typingCalls() {
  return signalRpcRequestMock.mock.calls.filter(([method]) => method === "sendTyping");
}

async function startReplyTyping(options: GetReplyOptions, mode: "instant" | "never" = "instant") {
  const typing = createTypingController({
    onReplyStart: options.onReplyStart,
    onCleanup: options.onTypingCleanup,
  });
  options.onTypingController?.(typing);
  await createTypingSignaler({ typing, mode, isHeartbeat: false }).signalRunStart();
}

function expectedTyping(target: { recipient: string[] } | { groupId: string }, stop = false) {
  return [
    "sendTyping",
    { ...target, account, ...(stop ? { stop: true } : {}) },
    { baseUrl, timeoutMs: undefined, transportKind: "container" },
  ];
}

describe("Signal monitor terminal typing", () => {
  beforeEach(() => {
    vi.mocked(sendTypingSignal).mockReset().mockImplementation(actualSend.sendTypingSignal);
    sendMock.mockResolvedValue({ messageId: "1700000000002" });
    logVerboseMock.mockReset();
    setSignalToolResultTestConfig({
      ...createSignalToolResultConfig({
        autoStart: false,
        accounts: {
          [accountId]: {
            account,
            transport: { kind: "container", url: baseUrl },
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
          },
        },
      }),
      agents: { defaults: { silentReply: { group: "allow" } } },
      messages: { visibleReplies: "automatic", inbound: { debounceMs: 0 } },
    });
  });

  it.each(["final reply", "NO_REPLY", "reply failure", "delivery failure", "cancelled reply"])(
    "stops provider typing after %s",
    async (outcome) => {
      replyMock.mockImplementation(async (_ctx, options: GetReplyOptions) => {
        await startReplyTyping(options);
        if (outcome === "reply failure") {
          throw new Error("reply failed");
        }
        if (outcome === "cancelled reply") {
          throw new DOMException("reply cancelled", "AbortError");
        }
        return { text: outcome === "NO_REPLY" ? "NO_REPLY" : "answer" };
      });
      if (outcome === "delivery failure") {
        sendMock.mockRejectedValue(new Error("delivery failed"));
      }

      const error = vi.fn();
      const groupId = outcome === "NO_REPLY" ? "typing-test-group" : undefined;
      await receiveSignalPayloads({
        payloads: [incomingMessage(recipient, groupId)],
        opts: { accountId, runtime: { ...createNonExitingRuntime(), error } },
      });

      expect(replyMock).toHaveBeenCalledOnce();
      if (outcome === "NO_REPLY" || outcome === "reply failure" || outcome === "cancelled reply") {
        expect(sendMock).not.toHaveBeenCalled();
      } else {
        expect(sendMock).toHaveBeenCalledExactlyOnceWith(
          recipient,
          "answer",
          expect.objectContaining({ account, accountId, baseUrl }),
        );
      }
      if (outcome === "reply failure" || outcome === "delivery failure") {
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining(outcome === "reply failure" ? "reply failed" : "delivery failed"),
        );
      } else if (outcome !== "cancelled reply") {
        expect(error).not.toHaveBeenCalled();
      }
      const target = groupId ? { groupId } : { recipient: [recipient] };
      expect(typingCalls()).toEqual([expectedTyping(target), expectedTyping(target, true)]);
    },
  );

  it("orders a late start before its stop without holding another chat open", async () => {
    const releaseStart = createDeferred();
    const stopped = createDeferred();
    const providerEffects: string[] = [];
    const secondRecipient = "+15550002222";
    let lateReplyStart: GetReplyOptions["onReplyStart"];
    signalRpcRequestMock.mockImplementation(async (method, params) => {
      if (method !== "sendTyping") {
        return {};
      }
      const target = params.recipient[0];
      if (target === recipient && !params.stop) {
        await releaseStart.promise;
      }
      providerEffects.push(`${target}:${params.stop ? "stop" : "start"}`);
      if (target === recipient && params.stop) {
        stopped.resolve();
      }
      return {};
    });
    replyMock.mockImplementation(async (_ctx, options: GetReplyOptions) => {
      lateReplyStart ??= options.onReplyStart;
      await startReplyTyping(options);
      return { text: "answer" };
    });

    try {
      await receiveSignalPayloads({
        payloads: [incomingMessage(), incomingMessage(secondRecipient)],
        opts: { accountId },
      });
      expect(sendMock).toHaveBeenCalledTimes(2);
      expect(typingCalls()).toEqual([
        expectedTyping({ recipient: [recipient] }),
        expectedTyping({ recipient: [secondRecipient] }),
        expectedTyping({ recipient: [secondRecipient] }, true),
      ]);
      vi.useFakeTimers();
      releaseStart.resolve();
      await stopped.promise;
      await lateReplyStart?.();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(providerEffects).toEqual([
        `${secondRecipient}:start`,
        `${secondRecipient}:stop`,
        `${recipient}:start`,
        `${recipient}:stop`,
      ]);
      expect(typingCalls()).toHaveLength(4);
    } finally {
      releaseStart.resolve();
      vi.useRealTimers();
    }
  });

  it("reports a failed stop without failing or repeating the reply", async () => {
    signalRpcRequestMock.mockImplementation(async (method, params) => {
      if (method === "sendTyping" && params.stop) {
        throw new Error("typing stop failed");
      }
      return {};
    });
    replyMock.mockImplementation(async (_ctx, options: GetReplyOptions) => {
      await startReplyTyping(options);
      return { text: "answer" };
    });
    await receiveSignalPayloads({ payloads: [incomingMessage()], opts: { accountId } });

    expect(sendMock).toHaveBeenCalledOnce();
    expect(typingCalls()).toHaveLength(2);
    expect(logVerboseMock).toHaveBeenCalledWith(
      expect.stringContaining("signal typing action=stop failed"),
    );
    expect(logVerboseMock).toHaveBeenCalledWith(expect.stringContaining("typing stop failed"));
  });

  it("does not start provider typing when the reply uses never mode", async () => {
    replyMock.mockImplementation(async (_ctx, options: GetReplyOptions) => {
      await startReplyTyping(options, "never");
      return { text: "answer" };
    });
    await receiveSignalPayloads({ payloads: [incomingMessage()], opts: { accountId } });

    expect(sendMock).toHaveBeenCalledOnce();
    // Shared terminal cleanup may stop an inactive indicator; it must never start one.
    expect(typingCalls()).toEqual([expectedTyping({ recipient: [recipient] }, true)]);
  });
});
