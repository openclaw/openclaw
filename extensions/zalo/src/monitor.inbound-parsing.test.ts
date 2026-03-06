import { describe, expect, it, vi } from "vitest";
import { ZaloApiAbortError, ZaloApiError, type ZaloMessage, type ZaloUpdate } from "./api.js";
import { __testing } from "./monitor.js";

function buildBaseMessage(overrides: Partial<ZaloMessage> = {}): ZaloMessage {
  return {
    message_id: "msg-1",
    from: { id: "user-1" },
    chat: { id: "chat-1", chat_type: "PRIVATE" },
    date: 1_700_000_000,
    ...overrides,
  };
}

describe("zalo inbound parsing", () => {
  it("keeps plain text when present", () => {
    const text = __testing.resolveInboundText(buildBaseMessage({ text: "  hello  " }));
    expect(text).toBe("hello");
  });

  it("extracts link preview text from attachments when message text is empty", () => {
    const text = __testing.resolveInboundText(
      buildBaseMessage({
        text: "   ",
        attachments: [
          {
            type: "link",
            payload: {
              title: "OpenClaw",
              url: "https://openclaw.ai",
              description: "AI gateway",
            },
          },
        ],
      }),
    );

    expect(text).toContain("OpenClaw");
    expect(text).toContain("https://openclaw.ai");
  });

  it("resolves image url from structured photo payload", () => {
    const resolved = __testing.resolveInboundImageUrl(
      buildBaseMessage({
        photo: {
          media_url: "https://cdn.example.com/photo.jpg",
        },
      }),
    );
    expect(resolved).toEqual({
      source: "photo:object",
      url: "https://cdn.example.com/photo.jpg",
    });
  });

  it("resolves image url from top-level photo_url payload field", () => {
    const resolved = __testing.resolveInboundImageUrl(
      buildBaseMessage({
        message_type: "CHAT_PHOTO",
        photo_url: "https://f21-zpc.zdn.vn/jpg/8446421582866817655/1c8fa4c96701e95fb010.jpg",
      }),
    );
    expect(resolved).toEqual({
      source: "message:top-level",
      url: "https://f21-zpc.zdn.vn/jpg/8446421582866817655/1c8fa4c96701e95fb010.jpg",
    });
  });

  it("resolves image url from image attachment payload", () => {
    const resolved = __testing.resolveInboundImageUrl(
      buildBaseMessage({
        attachments: [
          {
            type: "image",
            payload: {
              url: "https://cdn.example.com/image.png",
            },
          },
        ],
      }),
    );
    expect(resolved).toEqual({
      source: "attachments",
      url: "https://cdn.example.com/image.png",
    });
  });

  it("resolves sticker url from top-level payload field", () => {
    const resolved = __testing.resolveInboundStickerUrl(
      buildBaseMessage({
        sticker: "sticker-1",
        url: "https://zalo-api.zadn.vn/api/emoticon/oasticker?eid=1&size=130",
      }),
    );
    expect(resolved).toBe("https://zalo-api.zadn.vn/api/emoticon/oasticker?eid=1&size=130");
  });

  it("formats unhandled event payloads with truncation", () => {
    const update = {
      event_name: "message.link.received",
      message: buildBaseMessage({ text: "x".repeat(300) }),
    } satisfies ZaloUpdate;
    const formatted = __testing.formatUpdateForLog(update, 120);
    expect(formatted.endsWith("...")).toBe(true);
  });

  it("logs fallback details for unhandled event types", async () => {
    const log = vi.fn();
    await __testing.processUpdateForTesting(
      {
        event_name: "message.voice.received",
        message: buildBaseMessage({ text: "voice payload" }),
      },
      { log },
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("[zalo] Unhandled event message.voice.received"),
    );
  });

  it("logs when update has no message payload", async () => {
    const log = vi.fn();
    await __testing.processUpdateForTesting(
      {
        event_name: "message.text.received",
      },
      { log },
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("event without message payload"));
  });

  it("logs payload details for unsupported events", async () => {
    const log = vi.fn();
    await __testing.processUpdateForTesting(
      {
        event_name: "message.unsupported.received",
        message: buildBaseMessage({ text: "https://youtu.be/dQw4w9WgXcQ" }),
      },
      { log },
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[zalo] Unsupported event payload:"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("message.unsupported.received"));
  });

  it("does not send unsupported notices when dmPolicy is disabled", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} })));
    await __testing.processUpdateForTesting(
      {
        event_name: "message.unsupported.received",
        message: buildBaseMessage({ text: "unsupported payload" }),
      },
      {},
      fetcher,
      {
        accountConfig: {
          dmPolicy: "disabled",
        },
      },
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not send unsupported notices to non-allowlisted senders", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} })));
    await __testing.processUpdateForTesting(
      {
        event_name: "message.unsupported.received",
        message: buildBaseMessage({ text: "unsupported payload" }),
      },
      {},
      fetcher,
      {
        accountConfig: {
          dmPolicy: "allowlist",
          allowFrom: ["trusted-user"],
        },
      },
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends unsupported notices to allowlisted senders", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} })));
    await __testing.processUpdateForTesting(
      {
        event_name: "message.unsupported.received",
        message: buildBaseMessage({ text: "unsupported payload" }),
      },
      {},
      fetcher,
      {
        accountConfig: {
          dmPolicy: "allowlist",
          allowFrom: ["user-1"],
        },
      },
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("summarizes unsupported payload kind from attachments and extra fields", () => {
    const summary = __testing.summarizeUnsupportedInbound(
      buildBaseMessage({
        attachments: [{ type: "file" }],
        // Unknown key from API payloads for unsupported content.
        ...({ voice: { duration: 2 } } as unknown as Partial<ZaloMessage>),
      }),
    );
    expect(summary.kind).toContain("attachment:file");
    expect(summary.kind).toContain("voice");
    expect(summary.details).toContain("voice");
  });

  it("builds unsupported notice text with detected kind", () => {
    const notice = __testing.buildUnsupportedMessageNotice({
      kind: "attachment:file + voice",
      details: "fields=voice,file",
    });
    expect(notice).toContain("Sorry, this message type is not supported by Zalo Bot yet.");
    expect(notice).toContain("Please send it as plain text or an image.");
  });

  it("builds the same friendly unsupported notice for unknown kind", () => {
    const notice = __testing.buildUnsupportedMessageNotice({
      kind: "unknown",
    });
    expect(notice).toContain("Sorry, this message type is not supported by Zalo Bot yet.");
    expect(notice).toContain("Please send it as plain text or an image.");
  });

  it("builds sticker text hint from sticker payload", () => {
    const hint = __testing.buildStickerTextHint(
      buildBaseMessage({
        sticker: "sticker-123",
        message_type: "CHAT_STICKER",
      }),
      "https://zalo-api.zadn.vn/api/emoticon/oasticker?eid=1&size=130",
    );
    expect(hint).toContain("[sticker:sticker-123]");
    expect(hint).toContain("[type:CHAT_STICKER]");
    expect(hint).toContain(
      "[sticker_url:https://zalo-api.zadn.vn/api/emoticon/oasticker?eid=1&size=130]",
    );
    expect(hint).toContain("Reply with emoji only (1-3 emojis).");
    expect(hint).toContain("Do not use words");
  });

  it("normalizes sticker replies to emoji-only text", () => {
    expect(__testing.toEmojiOnlyReplyText("Pa pa kocicko! 👋🐱")).toBe("👋 🐱");
    expect(__testing.toEmojiOnlyReplyText("No emoji here")).toBe("🙂");
  });

  it("retries only retryable send errors", () => {
    expect(__testing.isRetryableSendError(new ZaloApiError("bad gateway", 502))).toBe(true);
    expect(__testing.isRetryableSendError(new ZaloApiError("bad request", 400))).toBe(false);
    expect(__testing.isRetryableSendError(new ZaloApiAbortError("timeout", "timeout"))).toBe(true);
    expect(__testing.isRetryableSendError(new ZaloApiAbortError("aborted", "aborted"))).toBe(false);
    expect(__testing.isRetryableSendError(new Error("fetch failed"))).toBe(true);
  });
});
