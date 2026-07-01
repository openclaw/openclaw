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

  it("sends quote-author for group replies when quoteAuthor is available", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567892 });

    await sendMessageSignal("group:test-group", "hello", {
      cfg: SIGNAL_TEST_CFG,
      textMode: "plain",
      replyTo: "1700000000000",
      quoteAuthor: "uuid:sender-1",
    });

    const params = signalRpcRequestMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(signalRpcRequestMock).toHaveBeenCalledWith(
      "send",
      expect.any(Object),
      expect.any(Object),
    );
    expect(params.groupId).toBe("test-group");
    expect(params["quote-timestamp"]).toBe(1700000000000);
    expect(params["quote-author"]).toBe("uuid:sender-1");
  });

  it("sends quote-timestamp for direct replies without quoteAuthor", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567895 });

    await sendMessageSignal("+15551230000", "hello", {
      cfg: SIGNAL_TEST_CFG,
      textMode: "plain",
      replyTo: "1700000000000",
    });

    const params = signalRpcRequestMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params["quote-timestamp"]).toBe(1700000000000);
    expect(params["quote-author"]).toBeUndefined();
  });

  it("ignores replyTo values with trailing non-numeric characters", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567893 });

    await sendMessageSignal("+15551230000", "hello", {
      cfg: SIGNAL_TEST_CFG,
      textMode: "plain",
      replyTo: "1700000000000abc",
      quoteAuthor: "uuid:sender-1",
    });

    const params = signalRpcRequestMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params["quote-timestamp"]).toBeUndefined();
    expect(params["quote-author"]).toBeUndefined();
  });

  it("skips group quote metadata when quoteAuthor is unavailable", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567894 });

    await sendMessageSignal("group:test-group", "hello", {
      cfg: SIGNAL_TEST_CFG,
      textMode: "plain",
      replyTo: "1700000000000",
    });

    const params = signalRpcRequestMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params["quote-timestamp"]).toBeUndefined();
    expect(params["quote-author"]).toBeUndefined();
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
});
