// Signal tests cover send plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const signalRpcRequestMock = vi.hoisted(() => vi.fn());
const resolveOutboundAttachmentFromUrlMock = vi.hoisted(() =>
  vi.fn(async (_params: unknown) => ({ path: "/tmp/image.png", contentType: "image/png" })),
);

vi.mock("./client-adapter.js", () => ({
  signalRpcRequest: (...args: unknown[]) => signalRpcRequestMock(...args),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return {
    ...actual,
    resolveOutboundAttachmentFromUrl: (params: unknown) =>
      resolveOutboundAttachmentFromUrlMock(params),
  };
});

const { sendMessageSignal } = await import("./send.js");

const SIGNAL_TEST_CFG = {
  channels: {
    signal: {
      accounts: {
        default: {
          httpUrl: "http://signal.test",
          account: "+15550001111",
        },
      },
    },
  },
};

describe("sendMessageSignal receipts", () => {
  beforeEach(() => {
    signalRpcRequestMock.mockReset();
    resolveOutboundAttachmentFromUrlMock.mockClear();
  });

  it("attaches a text receipt for timestamp results", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567890 });

    const result = await sendMessageSignal("+15551234567", "hello", {
      cfg: SIGNAL_TEST_CFG,
    });

    expect(result.messageId).toBe("1234567890");
    expect(result.timestamp).toBe(1234567890);
    expect(result.receipt.primaryPlatformMessageId).toBe("1234567890");
    expect(result.receipt.platformMessageIds).toEqual(["1234567890"]);
    expect(result.receipt.raw).toEqual([
      {
        channel: "signal",
        messageId: "1234567890",
        toJid: "+15551234567",
        timestamp: 1234567890,
        meta: { targetType: "recipient" },
      },
    ]);
    expect(result.receipt.parts).toEqual([
      {
        index: 0,
        platformMessageId: "1234567890",
        kind: "text",
        raw: {
          channel: "signal",
          messageId: "1234567890",
          toJid: "+15551234567",
          timestamp: 1234567890,
          meta: { targetType: "recipient" },
        },
      },
    ]);
    expect(result.receipt.sentAt).toBeGreaterThan(0);
  });

  it("attaches a media receipt for attachment sends", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567891 });

    const result = await sendMessageSignal("group:group-1", "", {
      cfg: SIGNAL_TEST_CFG,
      mediaUrl: "/tmp/image.png",
      mediaLocalRoots: ["/tmp"],
    });

    expect(resolveOutboundAttachmentFromUrlMock).toHaveBeenCalled();
    expect(result.messageId).toBe("1234567891");
    expect(result.timestamp).toBe(1234567891);
    expect(result.receipt.primaryPlatformMessageId).toBe("1234567891");
    expect(result.receipt.platformMessageIds).toEqual(["1234567891"]);
    expect(result.receipt.raw).toEqual([
      {
        channel: "signal",
        messageId: "1234567891",
        chatId: "group-1",
        timestamp: 1234567891,
        meta: { targetType: "group" },
      },
    ]);
    expect(result.receipt.parts).toEqual([
      {
        index: 0,
        platformMessageId: "1234567891",
        kind: "media",
        raw: {
          channel: "signal",
          messageId: "1234567891",
          chatId: "group-1",
          timestamp: 1234567891,
          meta: { targetType: "group" },
        },
      },
    ]);
    expect(result.receipt.sentAt).toBeGreaterThan(0);
  });

  it("does not invent platform ids when signal-cli omits a timestamp", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({});

    const result = await sendMessageSignal("+15551234567", "hello", {
      cfg: SIGNAL_TEST_CFG,
    });

    expect(result.messageId).toBe("unknown");
    expect(result.receipt.platformMessageIds).toStrictEqual([]);
  });

  it("does not add approval reactions to ordinary outbound approval-looking text", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567892 });
    const text = [
      "Here is the command you asked about:",
      "/approve exec-live-approval allow-once|deny",
    ].join("\n");

    await sendMessageSignal("+15551234567", text, {
      cfg: {
        ...SIGNAL_TEST_CFG,
        channels: {
          signal: {
            ...SIGNAL_TEST_CFG.channels.signal,
            allowFrom: ["+15551234567"],
          },
        },
        approvals: {
          exec: {
            enabled: true,
            mode: "targets",
            targets: [{ channel: "signal", to: "+15551234567" }],
          },
        },
      },
    });

    expect(signalRpcRequestMock).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({ message: text }),
      expect.any(Object),
    );
  });

  it("does not add approval reactions to ordinary outbound text quoting a full prompt", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567893 });
    const text = [
      "The docs show this example:",
      "Exec approval required",
      "ID: exec-live-approval",
      "",
      "Reply with: /approve exec-live-approval allow-once|deny",
    ].join("\n");

    await sendMessageSignal("+15551234567", text, {
      cfg: {
        ...SIGNAL_TEST_CFG,
        channels: {
          signal: {
            ...SIGNAL_TEST_CFG.channels.signal,
            allowFrom: ["+15551234567"],
          },
        },
        approvals: {
          exec: {
            enabled: true,
            mode: "targets",
            targets: [{ channel: "signal", to: "+15551234567" }],
          },
        },
      },
    });

    expect(signalRpcRequestMock).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({ message: text }),
      expect.any(Object),
    );
  });

  it("passes native quote metadata when replying to a Signal timestamp", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567892 });

    const result = await sendMessageSignal("+15551234567", "hello", {
      cfg: SIGNAL_TEST_CFG,
      replyToId: "1700000000001",
      replyToAuthor: "+15550002222",
      replyToBody: "original",
    });

    expect(signalRpcRequestMock).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        "quote-timestamp": 1700000000001,
        "quote-author": "+15550002222",
        "quote-message": "original",
      }),
      expect.any(Object),
    );
    expect(result.receipt.replyToId).toBe("1700000000001");
    expect(result.receipt.parts[0]?.replyToId).toBe("1700000000001");
    expect(result.receipt.raw?.[0]?.meta).toEqual({
      targetType: "recipient",
      replyToId: "1700000000001",
      nativeReplyStatus: "sent",
    });
  });

  it("falls back to an ordinary send when native quote metadata is rejected", async () => {
    signalRpcRequestMock
      .mockRejectedValueOnce(new Error("Signal RPC -32602: quote rejected"))
      .mockResolvedValueOnce({ timestamp: 1234567893 });

    const result = await sendMessageSignal("+15551234567", "hello", {
      cfg: SIGNAL_TEST_CFG,
      replyToId: "1700000000001",
      replyToAuthor: "+15550002222",
      replyToBody: "original",
    });

    expect(signalRpcRequestMock).toHaveBeenCalledTimes(2);
    expect(signalRpcRequestMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        "quote-timestamp": 1700000000001,
        "quote-author": "+15550002222",
      }),
    );
    expect(signalRpcRequestMock.mock.calls[1]?.[1]).not.toHaveProperty("quote-timestamp");
    expect(result.messageId).toBe("1234567893");
    expect(result.receipt.replyToId).toBe("1700000000001");
    expect(result.receipt.parts[0]?.replyToId).toBe("1700000000001");
    expect(result.receipt.raw?.[0]?.meta).toEqual({
      targetType: "recipient",
      replyToId: "1700000000001",
      nativeReplyStatus: "fallback",
    });
  });

  it("does not retry ordinary send failures as quote fallback", async () => {
    signalRpcRequestMock.mockRejectedValueOnce(new Error("Signal HTTP timed out after 10000ms"));

    await expect(
      sendMessageSignal("+15551234567", "hello", {
        cfg: SIGNAL_TEST_CFG,
        replyToId: "1700000000001",
        replyToAuthor: "+15550002222",
        replyToBody: "original",
      }),
    ).rejects.toThrow("Signal HTTP timed out");

    expect(signalRpcRequestMock).toHaveBeenCalledTimes(1);
  });
});
