import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { waitForAbortSignal } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it, vi } from "vitest";
import {
  createSignalToolResultConfig,
  getSignalToolResultTestMocks,
  installSignalToolResultTestHooks,
  setSignalToolResultTestConfig,
  receiveSignalPayloads,
  waitForSignalToolResultIngressDispatchIdle,
} from "./monitor.tool-result.test-harness.js";

installSignalToolResultTestHooks();

// Import after the harness registers `vi.mock(...)` for Signal internals.
const { monitorSignalProvider } = await import("./monitor.js");

const {
  replyMock,
  sendMock,
  streamMock,
  updateLastRouteMock,
  enqueueSystemEventMock,
  upsertPairingRequestMock,
} = getSignalToolResultTestMocks();

const nativeQuote = {
  replyToId: "1700000000001",
  replyToAuthor: "+15550001111",
  replyToBody: "quote me",
};

function configure(overrides: Record<string, unknown>) {
  setSignalToolResultTestConfig(createSignalToolResultConfig({ autoStart: false, ...overrides }));
}

function reaction(targetAuthor: string | undefined, extra = {}) {
  return { reactionMessage: { emoji: "✅", targetAuthor, targetSentTimestamp: 2, ...extra } };
}

function inboundEnvelope(envelope: Record<string, unknown>) {
  return { sourceNumber: "+15550001111", sourceName: "Ada", timestamp: 1, ...envelope };
}

const DEFAULT_ENVELOPE = { timestamp: 1700000000001, dataMessage: { message: "quote me" } };
function receiveSingleEnvelope(envelope: Record<string, unknown> = DEFAULT_ENVELOPE) {
  return receiveSignalPayloads({ payloads: [{ envelope: inboundEnvelope(envelope) }] });
}

function expectNoNativeQuote(options: unknown) {
  expect(options).not.toHaveProperty("replyToId");
  expect(options).not.toHaveProperty("replyToAuthor");
  expect(options).not.toHaveProperty("replyToBody");
}

function expectNoReplyDeliveryOrRouteUpdate() {
  expect(replyMock).not.toHaveBeenCalled();
  expect(sendMock).not.toHaveBeenCalled();
  expect(updateLastRouteMock).not.toHaveBeenCalled();
}

function setReactionNotificationConfig(mode: "all" | "own", extra: Record<string, unknown> = {}) {
  configure({ dmPolicy: "open", allowFrom: ["*"], reactionNotifications: mode, ...extra });
}

describe("monitorSignalProvider tool results", () => {
  it.each([true, false])("quotes final replies after a block (failed media=%s)", async (failed) => {
    configure({ replyToMode: "first", streaming: { block: { enabled: true } } });
    sendMock.mockResolvedValue({ messageId: "1700000000002" });
    if (failed) {
      sendMock.mockRejectedValueOnce(
        new PlatformMessageNotDispatchedError("not dispatched", { cause: new Error("offline") }),
      );
    }
    replyMock.mockImplementation(async (_ctx, options: GetReplyOptions) => {
      await options.onBlockReply?.({
        text: "Streamed block",
        ...(failed ? { mediaUrl: "https://example.com/block.png" } : {}),
      });
      return { text: "Final answer" };
    });

    await receiveSingleEnvelope();

    expect(sendMock.mock.calls.map((call) => call[1])).toEqual([
      "PFX Streamed block",
      "PFX Final answer",
    ]);
    expect(sendMock.mock.calls[0]?.[2]).toMatchObject({
      ...nativeQuote,
      ...(failed ? { mediaUrl: "https://example.com/block.png" } : {}),
    });
    if (failed) {
      expect(sendMock.mock.calls[1]?.[2]).toMatchObject(nativeQuote);
    } else {
      expect(sendMock.mock.calls[1]?.[2]).not.toHaveProperty("replyToId");
    }
  });

  it("passes group inbound quote metadata through group reply mode overrides", async () => {
    configure({ groupPolicy: "open", replyToMode: "off", replyToModeByChatType: { group: "all" } });
    replyMock.mockResolvedValue({ text: "group reply" });
    await receiveSingleEnvelope({
      timestamp: 1700000000001,
      dataMessage: {
        message: "group quote me",
        groupInfo: { groupId: "signal-group-id", groupName: "Testing realm" },
      },
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[0]).toBe("group:signal-group-id");
    expect(sendMock.mock.calls[0]?.[2]).toMatchObject({
      replyToId: "1700000000001",
      replyToAuthor: "+15550001111",
      replyToBody: "group quote me",
    });
  });

  it("keeps status notices outside the first quote slot", async () => {
    configure({ replyToMode: "first" });
    replyMock.mockResolvedValue([
      { text: "working", isStatusNotice: true },
      { text: "final reply" },
    ]);
    await receiveSingleEnvelope();
    expect(sendMock.mock.calls.map((call) => call[1])).toEqual(["PFX working", "PFX final reply"]);
    for (const call of sendMock.mock.calls) {
      expect(call[2]).toMatchObject(nativeQuote);
    }
  });

  it("keeps durable conversation events separate in batched reply mode", async ({ signal }) => {
    setSignalToolResultTestConfig({
      ...createSignalToolResultConfig({ autoStart: false, replyToMode: "batched" }),
      messages: { visibleReplies: "automatic", inbound: { debounceMs: 10 } },
    });
    replyMock.mockResolvedValue({ text: "reply" });
    const abortController = new AbortController();
    const eventsAccepted = Promise.withResolvers<void>();
    const messages = ["first message", "second message"].map((message, index) => ({
      timestamp: 1700000000001 + index,
      message,
      delivered: Promise.withResolvers<void>(),
    }));
    sendMock.mockImplementation(async () => {
      messages[sendMock.mock.calls.length - 1]?.delivered.resolve();
    });
    streamMock.mockImplementation(async ({ onEvent, abortSignal }) => {
      for (const { timestamp, message } of messages) {
        await onEvent({
          event: "receive",
          data: JSON.stringify({
            envelope: inboundEnvelope({ timestamp, dataMessage: { message } }),
          }),
        });
      }
      eventsAccepted.resolve();
      await waitForAbortSignal(abortSignal);
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const monitorPromise = monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: AbortSignal.any([abortController.signal, signal]),
    });
    const monitorStopped = monitorPromise.then(() => {
      throw new Error("Signal monitor stopped before delivering both replies");
    });
    try {
      await Promise.race([eventsAccepted.promise, monitorStopped]);
      for (const [index, { timestamp, message, delivered }] of messages.entries()) {
        // Pump admission can finish before the handler schedules its debounce.
        await Promise.race([waitForSignalToolResultIngressDispatchIdle(), monitorStopped]);
        await vi.advanceTimersByTimeAsync(10);
        await Promise.race([delivered.promise, monitorStopped]);
        expect(replyMock.mock.calls[index]?.[0]).toMatchObject({
          MessageSid: String(timestamp),
          RawBody: message,
        });
      }
    } finally {
      abortController.abort();
      await monitorPromise.finally(() => vi.useRealTimers());
    }
    expect(replyMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenCalledTimes(2);
    for (const call of sendMock.mock.calls) {
      expectNoNativeQuote(call[2]);
    }
  });

  it.each([
    [{ replyToId: "1700000000999" }, undefined, false],
    [{ replyToCurrent: false }, undefined, false],
    [{ replyToCurrent: true }, "off", true],
  ] as const)("applies explicit native quote override %j", async (payload, mode, quoted) => {
    if (mode) {
      configure({ replyToMode: mode });
    }
    replyMock.mockResolvedValue({ text: "final reply", ...payload });
    await receiveSingleEnvelope();
    expect(sendMock).toHaveBeenCalledTimes(1);
    const options = sendMock.mock.calls[0]?.[2];
    if (quoted) {
      expect(options).toMatchObject(nativeQuote);
    } else {
      expectNoNativeQuote(options);
    }
  });

  it("ignores reaction-only dataMessage.reaction events (don’t treat as broken attachments)", async () => {
    await receiveSingleEnvelope({
      dataMessage: {
        reaction: { emoji: "👍", targetAuthor: "+15550002222", targetSentTimestamp: 2 },
        attachments: [{}],
      },
    });
    expectNoReplyDeliveryOrRouteUpdate();
  });

  it("blocks reaction notifications from unauthorized senders", async () => {
    setReactionNotificationConfig("all", { dmPolicy: "allowlist", allowFrom: ["+15550007777"] });
    await receiveSingleEnvelope(reaction("+15550002222"));
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expectNoReplyDeliveryOrRouteUpdate();
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
  });

  it.each([
    ["UUID and phone", "+15550002222", undefined],
    ["UUID-only", undefined, "123e4567-e89b-12d3-a456-426614174000"],
  ] as const)(
    "notifies on own %s reactions from allowlisted senders",
    async (_name, targetAuthor, accountUuid) => {
      setReactionNotificationConfig("own", {
        account: "+15550002222",
        accountUuid,
        dmPolicy: "allowlist",
        allowFrom: ["+15550001111"],
      });
      await receiveSingleEnvelope(
        reaction(targetAuthor, { targetAuthorUuid: "123e4567-e89b-12d3-a456-426614174000" }),
      );
      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        expect.stringContaining("Signal reaction added"),
        expect.objectContaining({ sessionKey: "agent:main:main" }),
      );
      expectNoReplyDeliveryOrRouteUpdate();
      expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    },
  );

  it("processes messages when reaction metadata is present", async () => {
    replyMock.mockResolvedValue({ text: "pong" });
    await receiveSingleEnvelope({
      reactionMessage: { emoji: "👍", targetAuthor: "+15550002222", targetSentTimestamp: 2 },
      dataMessage: { message: "ping" },
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
