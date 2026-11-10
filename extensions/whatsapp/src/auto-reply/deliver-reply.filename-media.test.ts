import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { describe, expect, it, vi } from "vitest";
import { createAcceptedWhatsAppSendResult } from "../inbound/send-result.test-helper.js";
import { createTestWebInboundMessage } from "../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../inbound/types.js";
import { createWhatsAppReplyTransportContext, deliverWebReply } from "./deliver-reply.js";

const hoisted = vi.hoisted(() => ({
  transcodeAudioBufferToOpus: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return { ...actual, transcodeAudioBufferToOpus: hoisted.transcodeAudioBufferToOpus };
});

vi.mock("openclaw/plugin-sdk/web-media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/web-media")>()),
  loadWebMedia: vi.fn(),
}));

describe("WhatsApp filename-only media delivery", () => {
  it.each([
    ["photo.png", undefined, "image/png", "image", "filename-only-media"],
    ["clip.mp4", undefined, "video/mp4", "video", "filename-only-media"],
    ["voice.ogg", undefined, "audio/ogg; codecs=opus", "audio", "filename-only-media"],
    ["voice.mp3", undefined, "audio/ogg; codecs=opus", "audio", "opus-output"],
    ["report.pdf", undefined, "application/pdf", "document", "filename-only-media"],
    ["unknown.bin", undefined, "application/octet-stream", "document", "filename-only-media"],
    ["photo.png", "application/octet-stream", "image/png", "image", "filename-only-media"],
    ["photo.png", "application/pdf", "application/pdf", "document", "filename-only-media"],
  ] as const)(
    "delivers %s with %s as native %s",
    async (fileName, contentType, mimetype, payloadKey, expectedBuffer) => {
      vi.clearAllMocks();
      hoisted.transcodeAudioBufferToOpus.mockResolvedValue(Buffer.from("opus-output"));
      vi.mocked(loadWebMedia).mockResolvedValueOnce({
        buffer: Buffer.from("filename-only-media"),
        contentType,
        fileName,
        kind: contentType ? "document" : undefined,
      });
      const sendMedia = vi
        .fn<AdmittedWebInboundMessage["platform"]["sendMedia"]>()
        .mockResolvedValue(createAcceptedWhatsAppSendResult("media", "media-1"));
      const reply = vi
        .fn<AdmittedWebInboundMessage["platform"]["reply"]>()
        .mockResolvedValue(createAcceptedWhatsAppSendResult("text", "text-1"));
      const msg = createTestWebInboundMessage({
        platform: {
          senderJid: "222@s.whatsapp.net",
          reply,
          sendMedia,
        },
        admission: {
          accountId: "work",
          conversation: { kind: "group", id: "+10000000000" },
          sender: { id: "222@s.whatsapp.net" },
          senderAccess: { reasonCode: "group_policy_allowed" },
        },
      });

      await deliverWebReply({
        replyResult: { text: "caption", mediaUrl: "https://example.com/download" },
        transport: createWhatsAppReplyTransportContext(msg),
        maxMediaBytes: 1024 * 1024,
        textLimit: 200,
        replyLogger: { info: vi.fn(), warn: vi.fn() },
      });

      expect(sendMedia).toHaveBeenCalledOnce();
      const mediaPayload = sendMedia.mock.calls[0]?.[0];
      expect(mediaPayload).toMatchObject({
        [payloadKey]: Buffer.from(expectedBuffer),
        mimetype,
      });
      if (payloadKey === "audio") {
        expect(mediaPayload).toHaveProperty("ptt", true);
        expect(reply).toHaveBeenCalledWith("caption", undefined);
      } else {
        expect(mediaPayload).toHaveProperty("caption", "caption");
      }
      if (payloadKey === "document") {
        expect(mediaPayload).toHaveProperty("fileName", fileName);
      } else {
        expect(mediaPayload).not.toHaveProperty("document");
      }
    },
  );
});
