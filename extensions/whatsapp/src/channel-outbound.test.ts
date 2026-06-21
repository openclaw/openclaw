// Whatsapp tests cover channel outbound plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheInboundMessageMeta } from "./quoted-message.js";

const hoisted = vi.hoisted(() => ({
  sendMessageWhatsApp: vi.fn(async () => ({ messageId: "wa-1", toJid: "jid" })),
  sendPollWhatsApp: vi.fn(async () => ({ messageId: "poll-1", toJid: "jid" })),
}));

vi.mock("./send.js", () => ({
  sendMessageWhatsApp: hoisted.sendMessageWhatsApp,
  sendPollWhatsApp: hoisted.sendPollWhatsApp,
}));

vi.mock("./runtime.js", () => ({
  getWhatsAppRuntime: () => ({
    logging: {
      shouldLogVerbose: () => false,
    },
  }),
}));

let whatsappChannelOutbound: typeof import("./channel-outbound.js").whatsappChannelOutbound;

describe("whatsappChannelOutbound", () => {
  beforeAll(async () => {
    ({ whatsappChannelOutbound } = await import("./channel-outbound.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("drops leading blank lines but preserves intentional indentation", () => {
    expect(
      whatsappChannelOutbound.normalizePayload?.({
        payload: { text: "\n \n    indented" },
      }),
    ).toEqual({
      text: "    indented",
    });
  });

  it("keeps XML sanitizer normalization idempotent", () => {
    const raw = [
      "<function_calls>",
      '  <invoke name="send_message">',
      '    <parameter name="text">hidden</parameter>',
      "  </invoke>",
      "</function_calls>",
      "After",
    ].join("\n");
    const once = whatsappChannelOutbound.normalizePayload?.({ payload: { text: raw } });
    const twice = whatsappChannelOutbound.normalizePayload?.({ payload: { text: once?.text } });

    expect(once?.text).toBe("After");
    expect(twice?.text).toBe("After");
  });

  it("drops whitespace-only text after XML sanitizer removal", () => {
    const raw = [
      "  <function_calls>",
      '    <invoke name="send_message">',
      '      <parameter name="text">hidden</parameter>',
      "    </invoke>",
      "  </function_calls>",
    ].join("\n");

    expect(whatsappChannelOutbound.normalizePayload?.({ payload: { text: raw } })).toEqual({
      text: "",
    });
  });

  it("sanitizes XML tool payloads before plain HTML stripping", () => {
    const raw = [
      "Before",
      "<function_calls>",
      '  <invoke name="send_message">',
      '    <parameter name="text">hidden</parameter>',
      "  </invoke>",
      "</function_calls>",
      "After",
    ].join("\n");

    expect(whatsappChannelOutbound.sanitizeText?.({ text: raw, payload: { text: raw } })).toBe(
      "Before\n\nAfter",
    );
  });

  it("preserves indentation for live text sends", async () => {
    await whatsappChannelOutbound.sendText!({
      cfg: {},
      to: "5511999999999@c.us",
      text: "\n \n    indented",
    });

    expect(hoisted.sendMessageWhatsApp).toHaveBeenCalledWith("5511999999999@c.us", "    indented", {
      verbose: false,
      cfg: {},
      accountId: undefined,
      gifPlayback: undefined,
      preserveLeadingWhitespace: true,
    });
  });

  it("uses the live WhatsApp sender for quoted text replies", async () => {
    const legacySend = vi.fn(async () => ({ messageId: "legacy-1", toJid: "legacy-jid" }));
    cacheInboundMessageMeta("default", "5511999999999@c.us", "reply-live-1", {
      body: "original live body",
      fromMe: false,
      participant: "5511999999999@s.whatsapp.net",
    });

    await whatsappChannelOutbound.sendText!({
      cfg: {},
      to: "5511999999999@c.us",
      text: "quoted reply",
      replyToId: "reply-live-1",
      deps: {
        whatsapp: legacySend,
      },
    });

    expect(legacySend).not.toHaveBeenCalled();
    expect(hoisted.sendMessageWhatsApp).toHaveBeenCalledWith("5511999999999@c.us", "quoted reply", {
      verbose: false,
      cfg: {},
      accountId: undefined,
      gifPlayback: undefined,
      quotedMessageKey: {
        id: "reply-live-1",
        remoteJid: "5511999999999@c.us",
        fromMe: false,
        participant: "5511999999999@s.whatsapp.net",
        messageText: "original live body",
      },
      preserveLeadingWhitespace: true,
    });
  });

  it("uses the live WhatsApp sender for quoted media replies", async () => {
    const legacySend = vi.fn(async () => ({ messageId: "legacy-1", toJid: "legacy-jid" }));
    cacheInboundMessageMeta("default", "5511999999999@c.us", "reply-media-1", {
      body: "original media body",
      fromMe: false,
      participant: "5511999999999@s.whatsapp.net",
    });

    await whatsappChannelOutbound.sendMedia!({
      cfg: {},
      to: "5511999999999@c.us",
      text: "quoted image",
      mediaUrl: "/tmp/photo.png",
      replyToId: "reply-media-1",
      deps: {
        whatsapp: legacySend,
      },
    });

    expect(legacySend).not.toHaveBeenCalled();
    expect(hoisted.sendMessageWhatsApp).toHaveBeenCalledWith("5511999999999@c.us", "quoted image", {
      verbose: false,
      cfg: {},
      mediaUrl: "/tmp/photo.png",
      mediaAccess: undefined,
      mediaLocalRoots: undefined,
      mediaReadFile: undefined,
      accountId: undefined,
      gifPlayback: undefined,
      forceDocument: undefined,
      quotedMessageKey: {
        id: "reply-media-1",
        remoteJid: "5511999999999@c.us",
        fromMe: false,
        participant: "5511999999999@s.whatsapp.net",
        messageText: "original media body",
      },
      preserveLeadingWhitespace: true,
    });
  });

  it("rejects non-WhatsApp provider-prefixed outbound targets", () => {
    const result = whatsappChannelOutbound.resolveTarget?.({
      to: "telegram:1234567890",
      allowFrom: [],
      mode: undefined,
    });

    expect(result?.ok).toBe(false);
    expect(hoisted.sendMessageWhatsApp).not.toHaveBeenCalled();
  });

  it("preserves indentation for payload delivery", async () => {
    await whatsappChannelOutbound.sendPayload!({
      cfg: {},
      to: "5511999999999@c.us",
      text: "",
      payload: { text: "\n \n    indented" },
    });

    expect(hoisted.sendMessageWhatsApp).toHaveBeenCalledWith("5511999999999@c.us", "    indented", {
      verbose: false,
      cfg: {},
      accountId: undefined,
      gifPlayback: undefined,
      preserveLeadingWhitespace: true,
    });
  });
});
