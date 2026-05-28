import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

  // Regression tests for Gemini reasoning tag leak (#87712 / related to #6328).
  // Gemini 2.5 Pro with reasoning:true emits <think>/<final> tags that must be
  // stripped before delivery. These tests ensure the WhatsApp delivery pipeline
  // strips them consistently across all outbound paths.
  it("strips Gemini <think>/<final> reasoning tags from payload text", () => {
    const raw = "<think>\nThis is internal reasoning.\n</think>\n<final>\nUser-visible answer.\n</final>";
    expect(whatsappChannelOutbound.normalizePayload?.({ payload: { text: raw } })).toEqual({
      text: "User-visible answer.",
    });
  });

  it("strips standalone <think> block with no <final> wrapper", () => {
    const raw = "<think>\nInternal reasoning only.\n</think>\n\nActual reply here.";
    expect(whatsappChannelOutbound.normalizePayload?.({ payload: { text: raw } })).toEqual({
      text: "Actual reply here.",
    });
  });

  it("preserves user-visible text when no reasoning tags are present", () => {
    const raw = "Hello! How can I help you today?";
    expect(whatsappChannelOutbound.normalizePayload?.({ payload: { text: raw } })).toEqual({
      text: raw,
    });
  });

  it("strips reasoning tags from live text sends", async () => {
    await whatsappChannelOutbound.sendText!({
      cfg: {},
      to: "5511999999999@c.us",
      text: "<think>\nreasoning\n</think>\n<final>\nfinal answer\n</final>",
    });

    expect(hoisted.sendMessageWhatsApp).toHaveBeenCalledWith(
      "5511999999999@c.us",
      "final answer",
      expect.objectContaining({ preserveLeadingWhitespace: true }),
    );
  });
});
