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

const SIGNAL_BASE_URL = "http://127.0.0.1:8080";

const nativeQuote = {
  replyToId: "1700000000001",
  replyToAuthor: "+15550001111",
  replyToBody: "quote me",
};

function receiveSingleEnvelope(
  envelope: Record<string, unknown> = {
    timestamp: 1700000000001,
    dataMessage: { message: "quote me" },
  },
) {
  return receiveSignalPayloads({
    payloads: [
      {
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Ada",
          timestamp: 1,
          ...envelope,
        },
      },
    ],
  });
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
  setSignalToolResultTestConfig(
    createSignalToolResultConfig({
      autoStart: false,
      dmPolicy: "open",
      allowFrom: ["*"],
      reactionNotifications: mode,
      ...extra,
    }),
  );
}

describe("monitorSignalProvider tool results", () => {
  it.each([
    { failed: true, media: true, finalQuoted: true },
    { failed: false, media: false, finalQuoted: false },
  ] as const)(
    "quotes final replies after a block: failed=$failed media=$media",
    async ({ failed, media, finalQuoted }) => {
      setSignalToolResultTestConfig(
        createSignalToolResultConfig({
          autoStart: false,
          replyToMode: "first",
          streaming: { block: { enabled: true } },
        }),
      );
      sendMock.mockResolvedValue({ messageId: "1700000000002" });
      if (failed) {
        sendMock.mockRejectedValueOnce(
          new PlatformMessageNotDispatchedError("not dispatched", { cause: new Error("offline") }),
        );
      }
      replyMock.mockImplementation(async (_ctx, options: GetReplyOptions) => {
        await options.onBlockReply?.({
          text: "Streamed block",
          ...(media ? { mediaUrl: "https://example.com/block.png" } : {}),
        });
        return { text: "Final answer" };
      });

      await receiveSingleEnvelope({
        timestamp: 1700000000001,
        dataMessage: { message: "quote me" },
      });

      expect(sendMock).toHaveBeenCalledTimes(2);
      expect(sendMock.mock.calls.map((call) => call[1])).toEqual([
        "PFX Streamed block",
        "PFX Final answer",
      ]);
      expect(sendMock.mock.calls[0]?.[2]).toMatchObject(nativeQuote);
      if (media) {
        expect(sendMock.mock.calls[0]?.[2]).toHaveProperty(
          "mediaUrl",
          "https://example.com/block.png",
        );
      }
      if (finalQuoted) {
        expect(sendMock.mock.calls[1]?.[2]).toMatchObject(nativeQuote);
      } else {
        expect(sendMock.mock.calls[1]?.[2]).not.toHaveProperty("replyToId");
      }
    },
  );

  it("passes group inbound quote metadata through group reply mode overrides", async () => {
    setSignalToolResultTestConfig(
      createSignalToolResultConfig({
        autoStart: false,
        groupPolicy: "open",
        replyToMode: "off",
        replyToModeByChatType: { group: "all" },
      }),
    );
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
    setSignalToolResultTestConfig(
      createSignalToolResultConfig({ autoStart: false, replyToMode: "first" }),
    );
    replyMock.mockResolvedValue([
      { text: "working", isStatusNotice: true },
      { text: "final reply" },
    ]);
    await receiveSingleEnvelope();
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls.map((call) => call[1])).toEqual(["PFX working", "PFX final reply"]);
    for (const call of sendMock.mock.calls) {
      expect(call[2]).toMatchObject(nativeQuote);
    }
  });

  it("keeps durable conversation events separate in batched reply mode", async ({ signal }) => {
    setSignalToolResultTestConfig({
      ...createSignalToolResultConfig({
        autoStart: false,
        replyToMode: "batched",
      }),
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
            envelope: {
              sourceNumber: "+15550001111",
              sourceName: "Ada",
              timestamp,
              dataMessage: { message },
            },
          }),
        });
      }
      eventsAccepted.resolve();
      await waitForAbortSignal(abortSignal);
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const monitorPromise = monitorSignalProvider({
      autoStart: false,
      baseUrl: SIGNAL_BASE_URL,
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
      try {
        await monitorPromise;
      } finally {
        vi.useRealTimers();
      }
    }

    expect(replyMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenCalledTimes(2);
    for (const call of sendMock.mock.calls) {
      expectNoNativeQuote(call[2]);
    }
  });

  it("does not attach native quote metadata for a different explicit reply target", async () => {
    replyMock.mockResolvedValue({ text: "final reply", replyToId: "1700000000999" });

    await receiveSingleEnvelope();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expectNoNativeQuote(sendMock.mock.calls[0]?.[2]);
  });

  it("does not attach native quote metadata when the reply opts out of the current message", async () => {
    replyMock.mockResolvedValue({ text: "status reply", replyToCurrent: false });

    await receiveSingleEnvelope();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expectNoNativeQuote(sendMock.mock.calls[0]?.[2]);
  });

  it("keeps explicit current-message native quote metadata when reply mode is off", async () => {
    setSignalToolResultTestConfig(
      createSignalToolResultConfig({ autoStart: false, replyToMode: "off" }),
    );
    replyMock.mockResolvedValue({ text: "final reply", replyToCurrent: true });

    await receiveSingleEnvelope();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[2]).toMatchObject(nativeQuote);
  });

  it("ignores reaction-only dataMessage.reaction events (don’t treat as broken attachments)", async () => {
    await receiveSingleEnvelope({
      dataMessage: {
        reaction: {
          emoji: "👍",
          targetAuthor: "+15550002222",
          targetSentTimestamp: 2,
        },
        attachments: [{}],
      },
    });

    expectNoReplyDeliveryOrRouteUpdate();
  });

  it("blocks reaction notifications from unauthorized senders", async () => {
    setReactionNotificationConfig("all", {
      dmPolicy: "allowlist",
      allowFrom: ["+15550007777"],
    });
    await receiveSingleEnvelope({
      reactionMessage: { emoji: "✅", targetAuthor: "+15550002222", targetSentTimestamp: 2 },
    });
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expectNoReplyDeliveryOrRouteUpdate();
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: "UUID and phone", targetAuthor: "+15550002222", accountUuid: undefined },
    {
      name: "UUID-only",
      targetAuthor: undefined,
      accountUuid: "123e4567-e89b-12d3-a456-426614174000",
    },
  ])(
    "notifies on own $name reactions from allowlisted senders",
    async ({ targetAuthor, accountUuid }) => {
      setReactionNotificationConfig("own", {
        account: "+15550002222",
        accountUuid,
        dmPolicy: "allowlist",
        allowFrom: ["+15550001111"],
      });
      await receiveSingleEnvelope({
        reactionMessage: {
          emoji: "✅",
          targetAuthor,
          targetAuthorUuid: "123e4567-e89b-12d3-a456-426614174000",
          targetSentTimestamp: 2,
        },
      });
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
