import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageMatrixMock = vi.hoisted(() => vi.fn());

vi.mock("./matrix/send.js", () => ({
  sendMessageMatrix: sendMessageMatrixMock,
  sendPollMatrix: vi.fn(),
}));

vi.mock("./runtime.js", () => ({
  getMatrixRuntime: () => ({
    channel: {
      text: {
        chunkMarkdownText: (text: string, limit: number) => {
          // Simple chunker: split by limit
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

import { matrixOutbound } from "./outbound.js";

describe("sendPayload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMessageMatrixMock.mockResolvedValue({ messageId: "msg-1", roomId: "room-1" });
  });

  const baseCtx = {
    to: "!room:example.com",
    cfg: {} as any,
    payload: {} as any,
  };

  it("text-only delegates to sendText", async () => {
    const result = await matrixOutbound.sendPayload!({
      ...baseCtx,
      payload: { text: "hello" },
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.com",
      "hello",
      expect.objectContaining({}),
    );
    expect(result.channel).toBe("matrix");
    expect(result.messageId).toBe("msg-1");
  });

  it("single media delegates to sendMedia", async () => {
    const result = await matrixOutbound.sendPayload!({
      ...baseCtx,
      payload: { text: "caption", mediaUrl: "https://img.example.com/a.png" },
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.com",
      "caption",
      expect.objectContaining({ mediaUrl: "https://img.example.com/a.png" }),
    );
    expect(result.channel).toBe("matrix");
  });

  it("multi-media iterates URLs with caption on first", async () => {
    const result = await matrixOutbound.sendPayload!({
      ...baseCtx,
      payload: {
        text: "caption",
        mediaUrls: ["https://img.example.com/a.png", "https://img.example.com/b.png"],
      },
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(2);
    // First call has caption
    expect(sendMessageMatrixMock).toHaveBeenNthCalledWith(
      1,
      "!room:example.com",
      "caption",
      expect.objectContaining({ mediaUrl: "https://img.example.com/a.png" }),
    );
    // Second call has empty text
    expect(sendMessageMatrixMock).toHaveBeenNthCalledWith(
      2,
      "!room:example.com",
      "",
      expect.objectContaining({ mediaUrl: "https://img.example.com/b.png" }),
    );
    expect(result.channel).toBe("matrix");
  });

  it("empty payload returns no-op", async () => {
    const result = await matrixOutbound.sendPayload!({
      ...baseCtx,
      payload: {},
    });

    expect(sendMessageMatrixMock).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "matrix", messageId: "" });
  });

  it("returns no-op when chunker produces empty array", async () => {
    const chunkerSpy = vi.spyOn(matrixOutbound as any, "chunker").mockReturnValue([]);
    const sendTextSpy = vi.spyOn(matrixOutbound, "sendText");
    const result = await matrixOutbound.sendPayload!({
      ...baseCtx,
      payload: { text: "   " },
    } as never);
    expect(sendTextSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "matrix", messageId: "" });
    chunkerSpy.mockRestore();
    sendTextSpy.mockRestore();
  });

  it("chunking splits long text", async () => {
    // matrixOutbound.textChunkLimit is 4000
    const longText = "A".repeat(8000);
    const result = await matrixOutbound.sendPayload!({
      ...baseCtx,
      payload: { text: longText },
    });

    // Should be split into 2 chunks of 4000 chars each
    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMatrixMock).toHaveBeenNthCalledWith(
      1,
      "!room:example.com",
      "A".repeat(4000),
      expect.objectContaining({}),
    );
    expect(sendMessageMatrixMock).toHaveBeenNthCalledWith(
      2,
      "!room:example.com",
      "A".repeat(4000),
      expect.objectContaining({}),
    );
    expect(result.channel).toBe("matrix");
  });
});
