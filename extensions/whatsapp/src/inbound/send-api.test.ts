import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage } from "baileys";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { listMessageReceiptPlatformIds } from "openclaw/plugin-sdk/channel-outbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareWhatsAppOutboundMedia } from "../outbound-media-contract.js";
import { markdownToWhatsApp } from "../targets-runtime.js";
import { resolveWhatsAppOutboundMentions } from "./outbound-mentions.js";
import { createWebSendApi } from "./send-api.js";
import { normalizeWhatsAppSendResult, type WhatsAppSendResult } from "./send-result.js";

const recordChannelActivity = vi.hoisted(() => vi.fn());
const imageOps = vi.hoisted(() => ({
  getImageMetadata: vi.fn(),
  resizeToJpeg: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-activity-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/channel-activity-runtime")
  >("openclaw/plugin-sdk/channel-activity-runtime");
  return {
    ...actual,
    recordChannelActivity: (...args: unknown[]) => recordChannelActivity(...args),
  };
});

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return {
    ...actual,
    getImageMetadata: imageOps.getImageMetadata,
    resizeToJpeg: imageOps.resizeToJpeg,
  };
});

function createSocket() {
  return {
    sendMessage: vi.fn(
      async (
        _jid: string,
        _content: AnyMessageContent,
        _options?: MiscMessageGenerationOptions,
      ): Promise<WAMessage | undefined> => ({ key: { id: "msg-1" } }) as WAMessage,
    ),
    sendPresenceUpdate: vi.fn(async () => {}),
  };
}

describe("createWebSendApi", () => {
  const sock = createSocket();
  const { sendMessage } = sock;
  let api: ReturnType<typeof createWebSendApi>;

  beforeEach(() => {
    vi.clearAllMocks();
    imageOps.getImageMetadata.mockResolvedValue(null);
    imageOps.resizeToJpeg.mockRejectedValue(new Error("unexpected thumbnail generation"));
    api = createWebSendApi({ sock, defaultAccountId: "main" });
  });

  function withMentions(
    participants: Parameters<typeof resolveWhatsAppOutboundMentions>[0]["participants"] = [
      { id: "15551234567@s.whatsapp.net" },
    ],
  ) {
    return createWebSendApi({
      sock,
      defaultAccountId: "main",
      resolveOutboundMentions: ({ jid, text }) =>
        resolveWhatsAppOutboundMentions({ chatJid: jid, text, participants }),
    });
  }

  function expectPartial(failure: unknown, ids: string[], cause: unknown, calls: number) {
    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    if (!isChannelPartialDeliveryError(failure)) {
      throw new Error("accepted provider delivery was lost");
    }
    expect(failure.deliveryResult.messageIds).toEqual(ids);
    expect(failure.deliveryResult.receipt?.platformMessageIds).toEqual(ids);
    expect(failure).toHaveProperty("cause", cause);
    expect(sendMessage).toHaveBeenCalledTimes(calls);
    expectOutboundActivityOnce();
  }

  function expectFirstSendJid(jid: string) {
    expect(sendMessage.mock.calls[0]?.[0]).toBe(jid);
  }

  function expectSendContentFields(callIndex: number, fields: Record<string, unknown>) {
    for (const [key, value] of Object.entries(fields)) {
      expect(sendMessage.mock.calls[callIndex]?.[1]).toHaveProperty(key, value);
    }
  }

  function expectAccepted(result: WhatsAppSendResult, kind: string, messageId: string) {
    expect(result).toMatchObject({ kind, messageId, providerAccepted: true });
  }

  function expectOutboundActivityOnce(accountId = "main") {
    expect(recordChannelActivity).toHaveBeenCalledOnce();
    expect(recordChannelActivity).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId,
      direction: "outbound",
    });
  }

  it("sends structured contact messages through the canonical send path", async () => {
    const contact = Object.freeze({
      displayName: "QA Contact",
      vcard: "BEGIN:VCARD\nFN:QA Contact\nEND:VCARD",
    });
    const res = await api.sendContact("+1555", contact);

    expect(sendMessage).toHaveBeenCalledWith("1555@s.whatsapp.net", {
      contacts: {
        displayName: "QA Contact",
        contacts: [contact],
      },
    });
    expectAccepted(res, "contact", "msg-1");
    expect(recordChannelActivity).toHaveBeenCalledWith({
      channel: "whatsapp",
      accountId: "main",
      direction: "outbound",
    });
  });

  it("sends structured location messages through the canonical send path", async () => {
    const coordinates = { degreesLatitude: 37.7749, degreesLongitude: -122.4194 };
    const res = await api.sendLocation("+1555", { ...coordinates, name: "QA Location" });

    expect(sendMessage).toHaveBeenCalledWith("1555@s.whatsapp.net", {
      location: { address: undefined, ...coordinates, name: "QA Location" },
    });
    expectAccepted(res, "location", "msg-1");
  });

  it("sends structured sticker messages through the canonical send path", async () => {
    const payload = Buffer.from("webp");
    const res = await api.sendSticker("+1555", payload);

    expect(sendMessage).toHaveBeenCalledWith("1555@s.whatsapp.net", {
      sticker: payload,
      mimetype: "image/webp",
    });
    expectAccepted(res, "sticker", "msg-1");
  });

  it("only sends native mentions for visible phone numbers outside inline code", async () => {
    api = withMentions();
    const messageText = "literal \\` ping @15551234567";
    await api.sendMessage("120363000000000000@g.us", markdownToWhatsApp(messageText));
    expect(sendMessage).toHaveBeenCalledWith("120363000000000000@g.us", {
      text: messageText,
      mentions: ["15551234567@s.whatsapp.net"],
    });
  });

  it("preserves native video after canonicalizing mixed-case media MIME", async () => {
    const payload = Buffer.from("video");
    const media = await prepareWhatsAppOutboundMedia({
      buffer: payload,
      contentType: " Video/MP4; charset=binary ",
    });
    await api.sendMessage("+1555", "cap", media.buffer, media.mimetype);
    expectSendContentFields(0, { video: payload, caption: "cap", mimetype: "video/mp4" });
  });

  it("prepopulates image thumbnails and dimensions before Baileys media upload", async () => {
    const payload = Buffer.from("img");
    const thumbnail = Buffer.from("thumb");
    imageOps.getImageMetadata.mockResolvedValueOnce({ width: 640, height: 480 });
    imageOps.resizeToJpeg.mockResolvedValueOnce(thumbnail);

    await api.sendMessage("+1555", "cap", payload, "image/png");

    expect(imageOps.resizeToJpeg).toHaveBeenCalledWith({
      buffer: payload,
      maxSide: 32,
      quality: 50,
      withoutEnlargement: true,
    });
    expectSendContentFields(0, {
      image: payload,
      caption: "cap",
      mimetype: "image/png",
      jpegThumbnail: thumbnail.toString("base64"),
      width: 640,
      height: 480,
    });
  });

  it("adds native mention metadata to group media captions", async () => {
    api = withMentions();
    const payload = Buffer.from("img");

    await api.sendMessage("120363000000000000@g.us", "cap @15551234567", payload, "image/jpeg");

    expectFirstSendJid("120363000000000000@g.us");
    expectSendContentFields(0, {
      image: payload,
      caption: "cap @15551234567",
      mimetype: "image/jpeg",
      mentions: ["15551234567@s.whatsapp.net"],
    });
  });

  it("uses resolved mention caption text for forced-document media", async () => {
    api = withMentions([
      { id: "277038292303944:4@lid", phoneNumber: "5511976136970@s.whatsapp.net" },
    ]);
    const payload = Buffer.from("img");

    await api.sendMessage("120363000000000000@g.us", "cap @+5511976136970", payload, "image/jpeg", {
      asDocument: true,
      fileName: "promo.jpg",
    });

    expectFirstSendJid("120363000000000000@g.us");
    expectSendContentFields(0, {
      document: payload,
      fileName: "promo.jpg",
      caption: "cap @277038292303944",
      mimetype: "image/jpeg",
      mentions: ["277038292303944@lid"],
    });
  });

  it("sends visible text separately from push-to-talk voice notes", async () => {
    const payload = Buffer.from("aud");
    sendMessage
      .mockResolvedValueOnce({ key: { id: "voice-1" } })
      .mockResolvedValueOnce({ key: { id: "voice-text-1" } });
    const res = await api.sendMessage("+1555", "voice text", payload, "audio/ogg");
    expectFirstSendJid("1555@s.whatsapp.net");
    expectSendContentFields(0, {
      audio: payload,
      ptt: true,
      mimetype: "audio/ogg",
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, "1555@s.whatsapp.net", {
      text: "voice text",
    });
    expectAccepted(res, "media", "voice-1");
    expect(res.receipt ? listMessageReceiptPlatformIds(res.receipt) : []).toEqual([
      "voice-1",
      "voice-text-1",
    ]);
    expectOutboundActivityOnce();
  });

  it("composes accepted voice and caption receipts when the caption throws a nested partial", async () => {
    const bookkeepingError = new Error("accepted voice caption bookkeeping failed");
    const acceptedCaption = normalizeWhatsAppSendResult(
      { key: { id: "nested-voice-caption" } } as WAMessage,
      "text",
    );
    sendMessage.mockResolvedValueOnce({ key: { id: "nested-voice-media" } }).mockRejectedValueOnce(
      createChannelPartialDeliveryError(bookkeepingError, {
        messageIds: [acceptedCaption.messageId],
        receipt: acceptedCaption.receipt,
        visibleReplySent: true,
      }),
    );

    const failure = await api
      .sendMessage("+1555", "voice text", Buffer.from("voice"), "audio/ogg")
      .catch((caught: unknown) => caught);

    expectPartial(failure, ["nested-voice-media", "nested-voice-caption"], bookkeepingError, 2);
  });

  it("preserves the accepted voice receipt when Baileys never accepts its caption", async () => {
    sendMessage
      .mockResolvedValueOnce({ key: { id: "voice-accepted-no-caption" } })
      .mockResolvedValueOnce(undefined);

    const failure = await api
      .sendMessage("+1555", "voice text", Buffer.from("voice"), "audio/ogg")
      .catch((caught: unknown) => caught);

    expectPartial(
      failure,
      ["voice-accepted-no-caption"],
      expect.any(PlatformMessageNotDispatchedError),
      2,
    );
  });

  it("retains the accepted poll receipt when activity recording fails", async () => {
    const activityError = new Error("channel activity bookkeeping disconnected");
    sendMessage.mockResolvedValueOnce({ key: { id: "poll-accepted" } });
    recordChannelActivity.mockImplementationOnce(() => {
      throw activityError;
    });

    const failure = await api
      .sendPoll("+1555", { question: "Q?", options: ["a", "b"] })
      .catch((caught: unknown) => caught);

    expectPartial(failure, ["poll-accepted"], activityError, 1);
  });

  it("retains the first accepted voice receipt when immediate activity recording fails", async () => {
    const activityError = new Error("channel activity bookkeeping disconnected");
    sendMessage.mockResolvedValueOnce({ key: { id: "voice-accepted-3" } });
    recordChannelActivity.mockImplementationOnce(() => {
      throw activityError;
    });

    const failure = await api
      .sendMessage("+1555", "voice text", Buffer.from("voice"), "audio/ogg")
      .catch((caught: unknown) => caught);

    expectPartial(failure, ["voice-accepted-3"], activityError, 1);
  });

  it("supports video media and gifPlayback option", async () => {
    const payload = Buffer.from("vid");
    await api.sendMessage("+1555", "cap", payload, "video/mp4", { gifPlayback: true });
    expectFirstSendJid("1555@s.whatsapp.net");
    expectSendContentFields(0, {
      video: payload,
      caption: "cap",
      mimetype: "video/mp4",
      gifPlayback: true,
    });
  });

  it("sends reactions with participant JID normalization", async () => {
    const res = await api.sendReaction("+1555", "msg-2", "👍", false, "+1999");
    expectFirstSendJid("1555@s.whatsapp.net");
    expectSendContentFields(0, {
      "react.text": "👍",
      "react.key.remoteJid": "1555@s.whatsapp.net",
      "react.key.id": "msg-2",
      "react.key.fromMe": false,
      "react.key.participant": "1999@s.whatsapp.net",
    });
    expectAccepted(res, "reaction", "msg-1");
  });

  it("rejects an unaccepted Baileys voice send without recording outbound activity", async () => {
    sendMessage.mockResolvedValueOnce(undefined);
    await expect(
      api.sendMessage("+1555", "", Buffer.from("voice"), "audio/ogg"),
    ).rejects.toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(recordChannelActivity).not.toHaveBeenCalled();
  });

  it("sends media as document when mediaType is undefined", async () => {
    const mediaBuffer = Buffer.from("test");

    await api.sendMessage("123", "hello", mediaBuffer, undefined);

    expectFirstSendJid("123@s.whatsapp.net");
    expectSendContentFields(0, {
      document: mediaBuffer,
      mimetype: "application/octet-stream",
    });
  });

  it("preserves the quoted remoteJid provided by the outbound adapter", async () => {
    await api.sendMessage("+1555", "hello", undefined, undefined, {
      quotedMessageKey: {
        id: "quoted-1",
        remoteJid: "277038292303944@lid",
        fromMe: false,
        participant: "1234@s.whatsapp.net",
        messageText: "quoted body",
      },
    });

    expectFirstSendJid("1555@s.whatsapp.net");
    expect(sendMessage.mock.calls[0]?.[1]).toEqual({ text: "hello" });
    expect(sendMessage.mock.calls[0]?.[2]).toHaveProperty(
      "quoted.key",
      expect.objectContaining({
        remoteJid: "277038292303944@lid",
        id: "quoted-1",
      }),
    );
  });

  it("aligns a lookup-proven LID quote with the final PN destination", async () => {
    await api.sendMessage("+1555", "hello", undefined, undefined, {
      quotedMessageKey: {
        id: "quoted-self",
        remoteJid: "277038292303944@lid",
        fromMe: true,
        lookupTargetJid: "1555@s.whatsapp.net",
        messageText: "quoted body",
      },
    });

    expectFirstSendJid("1555@s.whatsapp.net");
    expect(sendMessage.mock.calls[0]?.[2]).toHaveProperty(
      "quoted.key",
      expect.objectContaining({
        remoteJid: "1555@s.whatsapp.net",
        id: "quoted-self",
        fromMe: true,
      }),
    );
  });
});

// #67378: Missing LID resolution sends messages into a sender-only ghost chat.
describe("createWebSendApi LID resolution (issue #67378)", () => {
  const sock = createSocket();
  const { sendMessage, sendPresenceUpdate } = sock;
  let authDir: string;
  let api: ReturnType<typeof createWebSendApi>;

  beforeEach(() => {
    vi.clearAllMocks();
    authDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wa-lid-"));
    fs.writeFileSync(path.join(authDir, "lid-mapping-15555550000.json"), JSON.stringify("987654"));
    api = createWebSendApi({ sock, defaultAccountId: "main", authDir });
  });

  afterEach(() => {
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  it("falls back to PN s.whatsapp.net when no LID mapping exists", async () => {
    await api.sendMessage("+33123456789", "hello");
    expect(sendMessage).toHaveBeenCalledWith("33123456789@s.whatsapp.net", { text: "hello" });
  });

  it("resolves PN to LID for sendReaction", async () => {
    await api.sendReaction("+15555550000", "msg-2", "1️⃣", true);
    expect(sendMessage.mock.calls[0]?.[0]).toBe("987654@lid");
    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({
      react: { text: "1️⃣", key: { remoteJid: "987654@lid", id: "msg-2", fromMe: true } },
    });
    expect(sendMessage.mock.calls[0]?.[1]).toHaveProperty("react.key.participant", undefined);
  });

  it("resolves PN to LID for sendComposingTo presence", async () => {
    await api.sendComposingTo("+15555550000");
    expect(sendPresenceUpdate).toHaveBeenCalledWith("composing", "987654@lid");
  });

  it("skips newsletter composing presence when authDir is provided", async () => {
    await api.sendComposingTo("120363401234567890@newsletter");
    expect(sendPresenceUpdate).not.toHaveBeenCalled();
  });
});
