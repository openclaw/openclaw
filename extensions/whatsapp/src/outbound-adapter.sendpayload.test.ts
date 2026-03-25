import { describe, expect, it, vi } from "vitest";
import { whatsappOutbound } from "./outbound-adapter.js";

describe("whatsappOutbound send retry", () => {
  it("retries sendText on transient network errors and succeeds on second attempt", async () => {
    const sendWhatsApp = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValue({ messageId: "wa-1", toJid: "jid" });

    const result = await whatsappOutbound.sendText!({
      cfg: { channels: { whatsapp: { retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0 } } } },
      to: "5511999999999@c.us",
      text: "hello",
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ messageId: "wa-1" });
  });

  it("does not retry sendText on non-transient errors", async () => {
    const sendWhatsApp = vi.fn().mockRejectedValue(new Error("forbidden: not allowed"));

    await expect(
      whatsappOutbound.sendText!({
        cfg: { channels: { whatsapp: { retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0 } } } },
        to: "5511999999999@c.us",
        text: "hello",
        deps: { sendWhatsApp },
      }),
    ).rejects.toThrow("forbidden: not allowed");

    // Non-transient error — no retries.
    expect(sendWhatsApp).toHaveBeenCalledTimes(1);
  });

  it("respects configured attempts limit for sendText", async () => {
    const sendWhatsApp = vi.fn().mockRejectedValue(new Error("connection timeout"));

    await expect(
      whatsappOutbound.sendText!({
        cfg: { channels: { whatsapp: { retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0 } } } },
        to: "5511999999999@c.us",
        text: "hello",
        deps: { sendWhatsApp },
      }),
    ).rejects.toThrow("connection timeout");

    expect(sendWhatsApp).toHaveBeenCalledTimes(2);
  });
});

describe("whatsappOutbound sendPayload", () => {
  it("trims leading whitespace for direct text sends", async () => {
    const sendWhatsApp = vi.fn(async () => ({ messageId: "wa-1", toJid: "jid" }));

    await whatsappOutbound.sendText!({
      cfg: {},
      to: "5511999999999@c.us",
      text: "\n \thello",
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenCalledWith("5511999999999@c.us", "hello", {
      verbose: false,
      cfg: {},
      accountId: undefined,
      gifPlayback: undefined,
    });
  });

  it("trims leading whitespace for direct media captions", async () => {
    const sendWhatsApp = vi.fn(async () => ({ messageId: "wa-1", toJid: "jid" }));

    await whatsappOutbound.sendMedia!({
      cfg: {},
      to: "5511999999999@c.us",
      text: "\n \tcaption",
      mediaUrl: "/tmp/test.png",
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenCalledWith("5511999999999@c.us", "caption", {
      verbose: false,
      cfg: {},
      mediaUrl: "/tmp/test.png",
      mediaLocalRoots: undefined,
      accountId: undefined,
      gifPlayback: undefined,
    });
  });

  it("trims leading whitespace for sendPayload text and caption delivery", async () => {
    const sendWhatsApp = vi.fn(async () => ({ messageId: "wa-1", toJid: "jid" }));

    await whatsappOutbound.sendPayload!({
      cfg: {},
      to: "5511999999999@c.us",
      text: "",
      payload: { text: "\n\nhello" },
      deps: { sendWhatsApp },
    });
    await whatsappOutbound.sendPayload!({
      cfg: {},
      to: "5511999999999@c.us",
      text: "",
      payload: { text: "\n\ncaption", mediaUrl: "/tmp/test.png" },
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenNthCalledWith(1, "5511999999999@c.us", "hello", {
      verbose: false,
      cfg: {},
      accountId: undefined,
      gifPlayback: undefined,
    });
    expect(sendWhatsApp).toHaveBeenNthCalledWith(2, "5511999999999@c.us", "caption", {
      verbose: false,
      cfg: {},
      mediaUrl: "/tmp/test.png",
      mediaLocalRoots: undefined,
      accountId: undefined,
      gifPlayback: undefined,
    });
  });

  it("skips whitespace-only text payloads", async () => {
    const sendWhatsApp = vi.fn();

    const result = await whatsappOutbound.sendPayload!({
      cfg: {},
      to: "5511999999999@c.us",
      text: "",
      payload: { text: "\n \t" },
      deps: { sendWhatsApp },
    });

    expect(result).toEqual({ channel: "whatsapp", messageId: "" });
    expect(sendWhatsApp).not.toHaveBeenCalled();
  });
});
