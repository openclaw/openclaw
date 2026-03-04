import type { ReplyPayload } from "openclaw/plugin-sdk/compat";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { zaloPlugin } from "./channel.js";

vi.mock("./send.js", () => ({
  sendMessageZalo: vi.fn().mockResolvedValue({ ok: true, messageId: "zl-1" }),
}));

function baseCtx(payload: ReplyPayload) {
  return {
    cfg: {},
    to: "123456789",
    text: "",
    payload,
  };
}

describe("zaloPlugin outbound sendPayload", () => {
  let mockedSend: ReturnType<typeof vi.mocked<(typeof import("./send.js"))["sendMessageZalo"]>>;

  beforeEach(async () => {
    const mod = await import("./send.js");
    mockedSend = vi.mocked(mod.sendMessageZalo);
    mockedSend.mockClear();
    mockedSend.mockResolvedValue({ ok: true, messageId: "zl-1" });
  });

  it("text-only delegates to sendText", async () => {
    mockedSend.mockResolvedValue({ ok: true, messageId: "zl-t1" });

    const result = await zaloPlugin.outbound!.sendPayload!(baseCtx({ text: "hello" }));

    expect(mockedSend).toHaveBeenCalledWith("123456789", "hello", expect.any(Object));
    expect(result).toMatchObject({ channel: "zalo", messageId: "zl-t1" });
  });

  it("single media delegates to sendMedia", async () => {
    mockedSend.mockResolvedValue({ ok: true, messageId: "zl-m1" });

    const result = await zaloPlugin.outbound!.sendPayload!(
      baseCtx({ text: "cap", mediaUrl: "https://example.com/a.jpg" }),
    );

    expect(mockedSend).toHaveBeenCalledWith(
      "123456789",
      "cap",
      expect.objectContaining({ mediaUrl: "https://example.com/a.jpg" }),
    );
    expect(result).toMatchObject({ channel: "zalo" });
  });

  it("multi-media iterates URLs with caption on first", async () => {
    mockedSend
      .mockResolvedValueOnce({ ok: true, messageId: "zl-1" })
      .mockResolvedValueOnce({ ok: true, messageId: "zl-2" });

    const result = await zaloPlugin.outbound!.sendPayload!(
      baseCtx({
        text: "caption",
        mediaUrls: ["https://example.com/1.jpg", "https://example.com/2.jpg"],
      }),
    );

    expect(mockedSend).toHaveBeenCalledTimes(2);
    expect(mockedSend).toHaveBeenNthCalledWith(
      1,
      "123456789",
      "caption",
      expect.objectContaining({ mediaUrl: "https://example.com/1.jpg" }),
    );
    expect(mockedSend).toHaveBeenNthCalledWith(
      2,
      "123456789",
      "",
      expect.objectContaining({ mediaUrl: "https://example.com/2.jpg" }),
    );
    expect(result).toMatchObject({ channel: "zalo", messageId: "zl-2" });
  });

  it("empty payload returns no-op", async () => {
    const result = await zaloPlugin.outbound!.sendPayload!(baseCtx({}));

    expect(mockedSend).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "zalo", messageId: "" });
  });

  it("chunking splits long text", async () => {
    mockedSend
      .mockResolvedValueOnce({ ok: true, messageId: "zl-c1" })
      .mockResolvedValueOnce({ ok: true, messageId: "zl-c2" });

    const longText = "a".repeat(3000);
    const result = await zaloPlugin.outbound!.sendPayload!(baseCtx({ text: longText }));

    // textChunkLimit is 2000 with chunkTextForOutbound, so it should split
    expect(mockedSend.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of mockedSend.mock.calls) {
      expect((call[1] as string).length).toBeLessThanOrEqual(2000);
    }
    expect(result).toMatchObject({ channel: "zalo" });
  });
});
