import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageIrcMock = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({
  sendMessageIrc: sendMessageIrcMock,
}));

vi.mock("./runtime.js", () => ({
  getIrcRuntime: () => ({
    channel: {
      text: {
        chunkMarkdownText: (text: string, limit: number) => {
          const chunks: string[] = [];
          for (let i = 0; i < text.length; i += limit) {
            chunks.push(text.slice(i, i + limit));
          }
          return chunks.length > 0 ? chunks : [text];
        },
      },
    },
  }),
}));

// Mock remaining imports that channel.ts pulls in
vi.mock("./accounts.js", () => ({
  listIrcAccountIds: vi.fn(() => []),
  resolveDefaultIrcAccountId: vi.fn(() => "default"),
  resolveIrcAccount: vi.fn(() => ({ config: {} })),
}));
vi.mock("./config-schema.js", () => ({ IrcConfigSchema: {} }));
vi.mock("./monitor.js", () => ({ monitorIrcProvider: vi.fn() }));
vi.mock("./normalize.js", () => ({
  normalizeIrcMessagingTarget: vi.fn(),
  looksLikeIrcTargetId: vi.fn(),
  isChannelTarget: vi.fn(),
  normalizeIrcAllowEntry: vi.fn(),
}));
vi.mock("./onboarding.js", () => ({ ircOnboardingAdapter: {} }));
vi.mock("./policy.js", () => ({
  resolveIrcGroupMatch: vi.fn(),
  resolveIrcRequireMention: vi.fn(),
}));
vi.mock("./probe.js", () => ({ probeIrc: vi.fn() }));

import { ircPlugin } from "./channel.js";

describe("sendPayload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMessageIrcMock.mockResolvedValue({ messageId: "irc-1" });
  });

  const baseCtx = {
    to: "#test",
    cfg: {} as any,
    payload: {} as any,
  };

  it("text-only delegates to sendText", async () => {
    const result = await ircPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "hello" },
    });

    expect(sendMessageIrcMock).toHaveBeenCalledTimes(1);
    expect(result.channel).toBe("irc");
  });

  it("single media delegates to sendMedia", async () => {
    const result = await ircPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "caption", mediaUrl: "https://example.com/a.png" },
    });

    expect(sendMessageIrcMock).toHaveBeenCalledTimes(1);
    // sendMedia combines text + "Attachment: <url>"
    expect(sendMessageIrcMock).toHaveBeenCalledWith(
      "#test",
      expect.stringContaining("Attachment: https://example.com/a.png"),
      expect.objectContaining({}),
    );
    expect(result.channel).toBe("irc");
  });

  it("multi-media iterates URLs with caption on first", async () => {
    const result = await ircPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: {
        text: "caption",
        mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
      },
    });

    expect(sendMessageIrcMock).toHaveBeenCalledTimes(2);
    // First call has caption + attachment
    expect(sendMessageIrcMock).toHaveBeenNthCalledWith(
      1,
      "#test",
      expect.stringContaining("caption"),
      expect.objectContaining({}),
    );
    // Second call has empty text + attachment
    expect(sendMessageIrcMock).toHaveBeenNthCalledWith(
      2,
      "#test",
      expect.stringContaining("Attachment: https://example.com/b.png"),
      expect.objectContaining({}),
    );
    expect(result.channel).toBe("irc");
  });

  it("empty payload returns no-op", async () => {
    const result = await ircPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: {},
    });

    expect(sendMessageIrcMock).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "irc", messageId: "" });
  });

  it("returns no-op when chunker produces empty array", async () => {
    const chunkerSpy = vi.spyOn(ircPlugin.outbound! as any, "chunker").mockReturnValue([]);
    const sendTextSpy = vi.spyOn(ircPlugin.outbound!, "sendText");
    const result = await ircPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "   " },
    } as never);
    expect(sendTextSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "irc", messageId: "" });
    chunkerSpy.mockRestore();
    sendTextSpy.mockRestore();
  });

  it("chunking splits long text", async () => {
    // ircPlugin.outbound.textChunkLimit is 350
    const longText = "A".repeat(700);
    const result = await ircPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: longText },
    });

    // Should be split into 2 chunks of 350 chars each
    expect(sendMessageIrcMock).toHaveBeenCalledTimes(2);
    expect(result.channel).toBe("irc");
  });
});
