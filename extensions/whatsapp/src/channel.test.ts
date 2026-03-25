import { describe, expect, it, vi } from "vitest";
import { whatsappPlugin } from "./channel.js";

describe("whatsappPlugin outbound sendMedia", () => {
  it("forwards mediaLocalRoots to sendMessageWhatsApp", async () => {
    const sendWhatsApp = vi.fn(async () => ({
      messageId: "msg-1",
      toJid: "15551234567@s.whatsapp.net",
    }));
    const mediaLocalRoots = ["/tmp/workspace"];

    const outbound = whatsappPlugin.outbound;
    if (!outbound?.sendMedia) {
      throw new Error("whatsapp outbound sendMedia is unavailable");
    }

    const result = await outbound.sendMedia({
      cfg: {} as never,
      to: "whatsapp:+15551234567",
      text: "photo",
      mediaUrl: "/tmp/workspace/photo.png",
      mediaLocalRoots,
      accountId: "default",
      deps: { sendWhatsApp },
      gifPlayback: false,
    });

    expect(sendWhatsApp).toHaveBeenCalledWith(
      "whatsapp:+15551234567",
      "photo",
      expect.objectContaining({
        verbose: false,
        mediaUrl: "/tmp/workspace/photo.png",
        mediaLocalRoots,
        accountId: "default",
        gifPlayback: false,
      }),
    );
    expect(result).toMatchObject({ channel: "whatsapp", messageId: "msg-1" });
  });
});
