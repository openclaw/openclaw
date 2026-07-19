// Whatsapp tests cover native outbound message metadata recording.
import type { WAMessage } from "baileys";
import { describe, expect, it, vi } from "vitest";
import { lookupInboundMessageMetaForTarget } from "../quoted-message.js";
import { createWhatsAppOutboundMessageRecorder } from "./outbound-message-cache.js";

describe("WhatsApp outbound message recorder", () => {
  it("retains prepared PN identity when a timed-out LID send is accepted late", async () => {
    const rememberBaileysMessage = vi.fn();
    const recorder = createWhatsAppOutboundMessageRecorder({
      accountId: "mapped-send",
      rememberBaileysMessage,
    });
    const message = { conversation: "sent through LID" };

    recorder.trackLateAccepted(
      "277038292303944@lid",
      Promise.resolve({ key: { id: "sent-1" }, message } as WAMessage),
      {
        remoteE164: "+15551230000",
        remoteJids: ["15551230000@s.whatsapp.net", "277038292303944@lid"],
      },
    );

    await vi.waitFor(() => {
      expect(
        lookupInboundMessageMetaForTarget("mapped-send", "15551230000@s.whatsapp.net", "sent-1"),
      ).toMatchObject({
        remoteJid: "277038292303944@lid",
        body: "sent through LID",
        fromMe: true,
      });
    });
    expect(rememberBaileysMessage).toHaveBeenCalledWith("277038292303944@lid", "sent-1", message);
  });
});
