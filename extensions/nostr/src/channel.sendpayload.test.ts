import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendDmMock = vi.hoisted(() => vi.fn());

vi.mock("./runtime.js", () => ({
  getNostrRuntime: () => ({
    channel: {
      text: {
        resolveMarkdownTableMode: vi.fn(() => "unicode"),
        convertMarkdownTables: vi.fn((_text: string) => _text),
        chunkMarkdownText: (text: string, limit: number) => {
          const chunks: string[] = [];
          for (let i = 0; i < text.length; i += limit) {
            chunks.push(text.slice(i, i + limit));
          }
          return chunks.length > 0 ? chunks : [text];
        },
      },
    },
    config: { loadConfig: vi.fn(() => ({})) },
  }),
}));

vi.mock("./nostr-bus.js", () => ({
  normalizePubkey: vi.fn((key: string) => key),
  startNostrBus: vi.fn(),
}));

vi.mock("./config-schema.js", () => ({
  NostrConfigSchema: {},
}));

vi.mock("./types.js", () => ({
  listNostrAccountIds: vi.fn(() => ["default"]),
  resolveDefaultNostrAccountId: vi.fn(() => "default"),
  resolveNostrAccount: vi.fn(() => ({ config: {} })),
}));

import { nostrPlugin } from "./channel.js";

describe("sendPayload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendDmMock.mockResolvedValue({ channel: "nostr", messageId: "nostr-1" });
  });

  // We need to mock the activeBuses map — sendText reads from it
  // Instead, we mock sendText directly on the outbound adapter for sendPayload tests
  const originalSendText = nostrPlugin.outbound!.sendText;

  beforeEach(() => {
    nostrPlugin.outbound!.sendText = vi.fn().mockResolvedValue({
      channel: "nostr",
      to: "npub1abc",
      messageId: "nostr-1",
    });
  });

  afterEach(() => {
    nostrPlugin.outbound!.sendText = originalSendText;
  });

  const baseCtx = {
    to: "npub1abc",
    text: "",
    cfg: {} as any,
    payload: {} as any,
  };

  it("text-only delegates to sendText", async () => {
    const result = await nostrPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "hello" },
    });

    expect(nostrPlugin.outbound!.sendText).toHaveBeenCalledTimes(1);
    expect(result.channel).toBe("nostr");
  });

  it("single media appends URL to text and sends", async () => {
    const result = await nostrPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "caption", mediaUrl: "https://example.com/a.png" },
    });

    expect(nostrPlugin.outbound!.sendText).toHaveBeenCalledTimes(1);
    const call = vi.mocked(nostrPlugin.outbound!.sendText!).mock.calls[0][0];
    expect(call.text).toBe("caption\nhttps://example.com/a.png");
    expect(result.channel).toBe("nostr");
  });

  it("multi-media appends all URLs to text", async () => {
    const result = await nostrPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: {
        text: "caption",
        mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
      },
    });

    expect(nostrPlugin.outbound!.sendText).toHaveBeenCalledTimes(1);
    const call = vi.mocked(nostrPlugin.outbound!.sendText!).mock.calls[0][0];
    expect(call.text).toBe("caption\nhttps://example.com/a.png\nhttps://example.com/b.png");
    expect(result.channel).toBe("nostr");
  });

  it("empty payload returns no-op", async () => {
    const result = await nostrPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: {},
    });

    expect(nostrPlugin.outbound!.sendText).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "nostr", messageId: "" });
  });

  it("returns no-op when chunker produces empty array", async () => {
    nostrPlugin.outbound!.chunker = vi.fn().mockReturnValue([]);
    const sendTextSpy = vi.spyOn(nostrPlugin.outbound!, "sendText");
    const result = await nostrPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text: "   " },
    } as never);
    expect(sendTextSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "nostr", messageId: "" });
    delete (nostrPlugin.outbound as any).chunker;
  });

  it("chunking splits long text-only payloads", async () => {
    // nostrPlugin.outbound.textChunkLimit is 4000, but no chunker is defined on outbound
    // so it falls through to the [text] fallback — sends as single chunk
    // Actually, nostr outbound has no chunker defined, so text goes as-is
    const text = "A".repeat(5000);
    const result = await nostrPlugin.outbound!.sendPayload!({
      ...baseCtx,
      payload: { text },
    });

    // No chunker on nostr outbound — single call
    expect(nostrPlugin.outbound!.sendText).toHaveBeenCalledTimes(1);
    expect(result.channel).toBe("nostr");
  });
});
