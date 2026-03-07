import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./runtime.js", () => ({
  getMSTeamsRuntime: () => ({
    channel: {
      text: {
        chunkMarkdownText: (text: string, limit: number) => {
          if (text.length <= limit) return [text];
          const chunks: string[] = [];
          for (let i = 0; i < text.length; i += limit) chunks.push(text.slice(i, i + limit));
          return chunks;
        },
      },
    },
  }),
}));

vi.mock("./send.js", () => ({
  sendMessageMSTeams: vi.fn().mockResolvedValue({ messageId: "ms1" }),
  sendPollMSTeams: vi
    .fn()
    .mockResolvedValue({ messageId: "poll1", conversationId: "c1", pollId: "p1" }),
}));

vi.mock("./polls.js", () => ({
  createMSTeamsPollStoreFs: () => ({
    createPoll: vi.fn(),
  }),
}));

import { msteamsOutbound } from "./outbound.js";

describe("sendPayload", () => {
  const sendText = vi.fn().mockResolvedValue({ channel: "msteams", messageId: "t1" });
  const sendMedia = vi.fn().mockResolvedValue({ channel: "msteams", messageId: "m1" });

  beforeEach(() => {
    vi.clearAllMocks();
    sendText.mockResolvedValue({ channel: "msteams", messageId: "t1" });
    sendMedia.mockResolvedValue({ channel: "msteams", messageId: "m1" });
    msteamsOutbound.sendText = sendText;
    msteamsOutbound.sendMedia = sendMedia;
  });

  const baseCtx = { cfg: {} as any, to: "conv123", accountId: "default" };

  it("delegates text-only payload to sendText", async () => {
    const result = await msteamsOutbound.sendPayload!({
      ...baseCtx,
      payload: { text: "hello" },
    } as any);
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText.mock.calls[0][0]).toMatchObject({ text: "hello" });
    expect(sendMedia).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "msteams", messageId: "t1" });
  });

  it("delegates single-media payload to sendMedia", async () => {
    const result = await msteamsOutbound.sendPayload!({
      ...baseCtx,
      payload: { text: "cap", mediaUrl: "https://img.png" },
    } as any);
    expect(sendMedia).toHaveBeenCalledOnce();
    expect(sendMedia.mock.calls[0][0]).toMatchObject({ text: "cap", mediaUrl: "https://img.png" });
    expect(result).toEqual({ channel: "msteams", messageId: "m1" });
  });

  it("iterates multi-media URLs with caption on first only", async () => {
    const result = await msteamsOutbound.sendPayload!({
      ...baseCtx,
      payload: { text: "cap", mediaUrls: ["https://a.png", "https://b.png", "https://c.png"] },
    } as any);
    expect(sendMedia).toHaveBeenCalledTimes(3);
    expect(sendMedia.mock.calls[0][0]).toMatchObject({ text: "cap", mediaUrl: "https://a.png" });
    expect(sendMedia.mock.calls[1][0]).toMatchObject({ text: "", mediaUrl: "https://b.png" });
    expect(sendMedia.mock.calls[2][0]).toMatchObject({ text: "", mediaUrl: "https://c.png" });
    expect(result).toEqual({ channel: "msteams", messageId: "m1" });
  });

  it("returns no-op for empty payload", async () => {
    const result = await msteamsOutbound.sendPayload!({
      ...baseCtx,
      payload: {},
    } as any);
    expect(sendText).not.toHaveBeenCalled();
    expect(sendMedia).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "msteams", messageId: "" });
  });

  it("returns no-op when chunker produces empty array", async () => {
    const chunkerSpy = vi.spyOn(msteamsOutbound as any, "chunker").mockReturnValue([]);
    const sendTextSpy = vi.spyOn(msteamsOutbound, "sendText");
    const result = await msteamsOutbound.sendPayload!({
      ...baseCtx,
      payload: { text: "   " },
    } as never);
    expect(sendTextSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "msteams", messageId: "" });
    chunkerSpy.mockRestore();
  });

  it("chunks long text before calling sendText", async () => {
    const longText = "x".repeat(8000);
    await msteamsOutbound.sendPayload!({
      ...baseCtx,
      payload: { text: longText },
    } as any);
    // textChunkLimit is 4000, chunker splits into 2 chunks
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText.mock.calls[0][0].text).toBe("x".repeat(4000));
    expect(sendText.mock.calls[1][0].text).toBe("x".repeat(4000));
  });
});
