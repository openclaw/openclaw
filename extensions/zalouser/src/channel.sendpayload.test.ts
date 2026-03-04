import type { ReplyPayload } from "openclaw/plugin-sdk/compat";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { zalouserPlugin } from "./channel.js";

vi.mock("./send.js", () => ({
  sendMessageZalouser: vi.fn().mockResolvedValue({ ok: true, messageId: "zlu-1" }),
  sendReactionZalouser: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("./accounts.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveZalouserAccountSync: () => ({
      accountId: "default",
      profile: "default",
      name: "test",
      enabled: true,
      config: {},
    }),
  };
});

function baseCtx(payload: ReplyPayload) {
  return {
    cfg: {},
    to: "987654321",
    text: "",
    payload,
  };
}

describe("zalouserPlugin outbound sendPayload", () => {
  let mockedSend: ReturnType<typeof vi.mocked<(typeof import("./send.js"))["sendMessageZalouser"]>>;

  beforeEach(async () => {
    const mod = await import("./send.js");
    mockedSend = vi.mocked(mod.sendMessageZalouser);
    mockedSend.mockClear();
    mockedSend.mockResolvedValue({ ok: true, messageId: "zlu-1" });
  });

  it("text-only delegates to sendText", async () => {
    mockedSend.mockResolvedValue({ ok: true, messageId: "zlu-t1" });

    const result = await zalouserPlugin.outbound!.sendPayload!(baseCtx({ text: "hello" }));

    expect(mockedSend).toHaveBeenCalledWith("987654321", "hello", expect.any(Object));
    expect(result).toMatchObject({ channel: "zalouser", messageId: "zlu-t1" });
  });

  it("single media delegates to sendMedia", async () => {
    mockedSend.mockResolvedValue({ ok: true, messageId: "zlu-m1" });

    const result = await zalouserPlugin.outbound!.sendPayload!(
      baseCtx({ text: "cap", mediaUrl: "https://example.com/a.jpg" }),
    );

    expect(mockedSend).toHaveBeenCalledWith(
      "987654321",
      "cap",
      expect.objectContaining({ mediaUrl: "https://example.com/a.jpg" }),
    );
    expect(result).toMatchObject({ channel: "zalouser" });
  });

  it("multi-media iterates URLs with caption on first", async () => {
    mockedSend
      .mockResolvedValueOnce({ ok: true, messageId: "zlu-1" })
      .mockResolvedValueOnce({ ok: true, messageId: "zlu-2" });

    const result = await zalouserPlugin.outbound!.sendPayload!(
      baseCtx({
        text: "caption",
        mediaUrls: ["https://example.com/1.jpg", "https://example.com/2.jpg"],
      }),
    );

    expect(mockedSend).toHaveBeenCalledTimes(2);
    expect(mockedSend).toHaveBeenNthCalledWith(
      1,
      "987654321",
      "caption",
      expect.objectContaining({ mediaUrl: "https://example.com/1.jpg" }),
    );
    expect(mockedSend).toHaveBeenNthCalledWith(
      2,
      "987654321",
      "",
      expect.objectContaining({ mediaUrl: "https://example.com/2.jpg" }),
    );
    expect(result).toMatchObject({ channel: "zalouser", messageId: "zlu-2" });
  });

  it("empty payload returns no-op", async () => {
    const result = await zalouserPlugin.outbound!.sendPayload!(baseCtx({}));

    expect(mockedSend).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "zalouser", messageId: "" });
  });

  it("chunking splits long text", async () => {
    mockedSend
      .mockResolvedValueOnce({ ok: true, messageId: "zlu-c1" })
      .mockResolvedValueOnce({ ok: true, messageId: "zlu-c2" });

    const longText = "a".repeat(3000);
    const result = await zalouserPlugin.outbound!.sendPayload!(baseCtx({ text: longText }));

    // textChunkLimit is 2000 with chunkTextForOutbound, so it should split
    expect(mockedSend.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of mockedSend.mock.calls) {
      expect((call[1] as string).length).toBeLessThanOrEqual(2000);
    }
    expect(result).toMatchObject({ channel: "zalouser" });
  });
});
