import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WAMessage } from "baileys";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { listMessageReceiptPlatformIds } from "openclaw/plugin-sdk/channel-outbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareWhatsAppOutboundMedia } from "../outbound-media-contract.js";
import { markdownToWhatsApp } from "../targets-runtime.js";
import {
  resolveWhatsAppOutboundMentions,
  type WhatsAppOutboundMentionParticipant,
} from "./outbound-mentions.js";
import { createWebSendApi } from "./send-api.js";
import {
  combineWhatsAppSendResults,
  mergeWhatsAppAcceptedSendError,
  normalizeWhatsAppSendResult,
  type WhatsAppSendResult,
} from "./send-result.js";

const DM_JID = "1555@s.whatsapp.net";
const GROUP_JID = "120363000000000000@g.us";
const LID_JID = "277038292303944@lid";
const MEDIA = Buffer.from("media");
const THUMBNAIL = Buffer.from("thumb");
const PREVIEW = { jpegThumbnail: THUMBNAIL.toString("base64"), width: 640, height: 480 };

const recordChannelActivity = vi.hoisted(() => vi.fn());
const imageOps = vi.hoisted(() => ({
  getImageMetadata: vi.fn(),
  resizeToJpeg: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-activity-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-activity-runtime")>()),
  recordChannelActivity,
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  ...imageOps,
}));

const acceptedMessage = (id: string): WAMessage => ({ key: { id } });

describe("createWebSendApi", () => {
  const sock = {
    sendMessage: vi.fn<Parameters<typeof createWebSendApi>[0]["sock"]["sendMessage"]>(async () =>
      acceptedMessage("msg-1"),
    ),
    sendPresenceUpdate: vi.fn(async () => {}),
  };
  const { sendMessage } = sock;
  let api: ReturnType<typeof createWebSendApi>;

  beforeEach(() => {
    vi.clearAllMocks();
    imageOps.getImageMetadata.mockResolvedValue(null);
    imageOps.resizeToJpeg.mockRejectedValue(new Error("unexpected thumbnail generation"));
    api = createWebSendApi({ sock, defaultAccountId: "main" });
  });
  function expectPartial(failure: unknown, ids: string[], cause: unknown, calls = 2) {
    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    expect(failure).toMatchObject({
      cause,
      deliveryResult: { messageIds: ids, receipt: { platformMessageIds: ids } },
    });
    expect(sendMessage).toHaveBeenCalledTimes(calls);
    expectOutboundActivityOnce();
  }
  function expectSend(fields: Record<string, unknown>, jid = DM_JID) {
    expect(sendMessage.mock.calls[0]?.slice(0, 2)).toMatchObject([jid, fields]);
  }

  function expectAccepted(result: WhatsAppSendResult, kind: string, messageId = "msg-1") {
    expect(result).toMatchObject({ kind, messageId, providerAccepted: true });
  }

  function expectOutboundActivityOnce(accountId = "main") {
    expect(recordChannelActivity).toHaveBeenCalledExactlyOnceWith({
      channel: "whatsapp",
      accountId,
      direction: "outbound",
    });
  }
  const voice = () => api.sendMessage("+1555", "voice text", MEDIA, "audio/ogg");
  const failure = (send = voice) => send().catch((caught: unknown) => caught);

  const vcard = "BEGIN:VCARD\nFN:QA Contact\nEND:VCARD";
  const contact = { displayName: "QA Contact", vcard };
  const location = { degreesLatitude: 37.7749, degreesLongitude: -122.4194, name: "QA Location" };
  const sticker = Buffer.from("webp");
  it.each([
    [
      "contact",
      () => api.sendContact("+1555", contact),
      { contacts: { displayName: contact.displayName, contacts: [contact] } },
    ],
    [
      "location",
      () => api.sendLocation("+1555", location),
      { location: { address: undefined, ...location } },
    ],
    ["sticker", () => api.sendSticker("+1555", sticker), { sticker, mimetype: "image/webp" }],
  ] as const)("sends structured %s messages", async (kind, send, content) => {
    expectAccepted(await send(), kind);
    expect(sendMessage).toHaveBeenCalledWith(DM_JID, content);
    expectOutboundActivityOnce();
  });

  const PN = "15551234567@s.whatsapp.net";
  const phone = [{ id: PN }];
  const mapped = [{ id: "277038292303944:4@lid", phoneNumber: "5511976136970@s.whatsapp.net" }];
  const code = "`inline @+5511976136970`\n```\nfenced @+5511976136970\n```";
  const tagged = "hi @+15551234567";
  const escaped = "literal \\` ping ";
  const target = "@277038292303944";
  const source = "@+5511976136970";
  const line = `visible ${source}\n${code}\nagain ${source}`;
  const expectedLine = `visible ${target}\n${code}\nagain ${target}`;
  type Participants = readonly WhatsAppOutboundMentionParticipant[];
  function useMentions(participants: Participants) {
    api = createWebSendApi({
      sock,
      defaultAccountId: "main",
      resolveOutboundMentions: ({ jid, text }) =>
        resolveWhatsAppOutboundMentions({ chatJid: jid, text, participants }),
    });
  }
  type MentionCase = [Participants, string, string, string[], string?];
  it.each<MentionCase>([
    [mapped, markdownToWhatsApp(escaped + source), escaped + target, [LID_JID]],
    [[{ id: LID_JID, e164: "+15551234567" }], "ping @15551234567", "ping " + target, [LID_JID]],
    [
      [{ id: PN, lid: LID_JID }],
      "ping @15551234567 and " + target,
      `ping ${target} and ${target}`,
      [LID_JID],
    ],
    [mapped, line, expectedLine, [LID_JID]],
    [mapped, "Run `notify\n" + source, "Run `notify\n" + source, []],
    [mapped, "Run ``notify ` " + source, "Run ``notify ` " + source, []],
    [phone, tagged, tagged, [], PN],
    [[{ id: "15550000000@s.whatsapp.net" }], tagged, tagged, []],
  ])("native mentions %#", async (participants, text, expected, mentions, to = GROUP_JID) => {
    useMentions(participants);
    await api.sendMessage(to, text);
    expect(sendMessage).toHaveBeenCalledWith(
      to,
      mentions.length ? { text: expected, mentions } : { text: expected },
    );
  });

  it.each(["image", "document"] as const)("sends %s captions with mentions", async (kind) => {
    useMentions(kind === "image" ? phone : mapped);
    if (kind === "image") {
      imageOps.getImageMetadata.mockResolvedValueOnce({ width: 640, height: 480 });
      imageOps.resizeToJpeg.mockResolvedValueOnce(THUMBNAIL);
    }
    const asDocument = kind === "document";
    await api.sendMessage(
      GROUP_JID,
      asDocument ? "cap " + source : "cap @15551234567",
      MEDIA,
      "image/jpeg",
      asDocument ? { asDocument, fileName: "promo.jpg" } : undefined,
    );
    expectSend(
      {
        [kind]: MEDIA,
        mimetype: "image/jpeg",
        caption: asDocument ? "cap " + target : "cap @15551234567",
        mentions: [asDocument ? LID_JID : PN],
        ...(asDocument ? { fileName: "promo.jpg" } : PREVIEW),
      },
      GROUP_JID,
    );
  });

  it.each([
    [" Video/MP4; charset=binary ", "video/mp4", "video", undefined],
    ["video/mp4", "video/mp4", "video", { gifPlayback: true }],
    [undefined, "application/octet-stream", "document", undefined],
  ] as const)("sends media %s as %s", async (inputType, mimetype, kind, options) => {
    const media = inputType
      ? await prepareWhatsAppOutboundMedia({ buffer: MEDIA, contentType: inputType })
      : { buffer: MEDIA, mimetype: undefined };
    await api.sendMessage("+1555", "cap", media.buffer, media.mimetype, options);
    expectSend({ [kind]: MEDIA, caption: "cap", mimetype, ...options });
  });

  it("sends voice text separately and combines both receipts", async () => {
    sendMessage
      .mockResolvedValueOnce(acceptedMessage("voice-1"))
      .mockResolvedValueOnce(acceptedMessage("voice-text-1"));
    const res = await voice();
    expectSend({ audio: MEDIA, ptt: true, mimetype: "audio/ogg" });
    expect(sendMessage).toHaveBeenNthCalledWith(2, DM_JID, { text: "voice text" });
    expectAccepted(res, "media", "voice-1");
    expect(res.receipt ? listMessageReceiptPlatformIds(res.receipt) : []).toEqual([
      "voice-1",
      "voice-text-1",
    ]);
    expectOutboundActivityOnce();
  });

  it("combines voice and nested partial-caption receipts", async () => {
    const bookkeepingError = new Error("caption bookkeeping failed");
    const acceptedCaption = normalizeWhatsAppSendResult(acceptedMessage("caption"), "text");
    sendMessage.mockResolvedValueOnce(acceptedMessage("voice")).mockRejectedValueOnce(
      createChannelPartialDeliveryError(bookkeepingError, {
        messageIds: [acceptedCaption.messageId],
        receipt: acceptedCaption.receipt,
        visibleReplySent: true,
      }),
    );
    expectPartial(await failure(), ["voice", "caption"], bookkeepingError);
  });

  it("retains voice receipts when the caption is unaccepted", async () => {
    sendMessage.mockResolvedValueOnce(acceptedMessage("voice")).mockResolvedValueOnce(undefined);
    expectPartial(await failure(), ["voice"], expect.any(PlatformMessageNotDispatchedError));
  });

  it.each([
    ["poll", () => api.sendPoll("+1555", { question: "Q?", options: ["a", "b"] })],
    ["voice", voice],
  ] as const)("retains accepted %s on activity failure", async (_kind, send) => {
    const activityError = new Error("activity bookkeeping disconnected");
    sendMessage.mockResolvedValueOnce(acceptedMessage("accepted"));
    recordChannelActivity.mockImplementationOnce(() => {
      throw activityError;
    });
    expectPartial(await failure(send), ["accepted"], activityError, 1);
  });

  it("rejects an unaccepted Baileys voice send without recording outbound activity", async () => {
    sendMessage.mockResolvedValueOnce(undefined);
    await expect(api.sendMessage("+1555", "", MEDIA, "audio/ogg")).rejects.toBeInstanceOf(
      PlatformMessageNotDispatchedError,
    );
    expect(recordChannelActivity).not.toHaveBeenCalled();
  });

  it("forwards quote context to the provider", async () => {
    await api.sendMessage("+1555", "hello", undefined, undefined, {
      quotedMessageKey: {
        id: "quoted-1",
        remoteJid: LID_JID,
        fromMe: true,
        lookupTargetJid: DM_JID,
        messageText: "quoted body",
      },
    });
    expect(sendMessage.mock.calls[0]?.[2]).toHaveProperty(
      "quoted.key",
      expect.objectContaining({ remoteJid: DM_JID, id: "quoted-1", fromMe: true }),
    );
  });
  // #67378: Missing LID resolution sends messages into a sender-only ghost chat.
  describe("createWebSendApi LID resolution (issue #67378)", () => {
    const { sendPresenceUpdate } = sock;
    let authDir: string;

    beforeEach(() => {
      authDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wa-lid-"));
      fs.writeFileSync(
        path.join(authDir, "lid-mapping-15555550000.json"),
        JSON.stringify("987654"),
      );
      api = createWebSendApi({ sock, defaultAccountId: "main", authDir });
    });

    afterEach(() => {
      fs.rmSync(authDir, { recursive: true, force: true });
    });

    it("falls back to PN s.whatsapp.net when no LID mapping exists", async () => {
      await api.sendMessage("+33123456789", "hello");
      expect(sendMessage).toHaveBeenCalledWith("33123456789@s.whatsapp.net", { text: "hello" });
    });

    it.each([undefined, "+1999"])(
      "resolves reaction JIDs with participant %s",
      async (participant) => {
        expectAccepted(
          await api.sendReaction("+15555550000", "msg-2", "👍", true, participant),
          "reaction",
        );
        expect(sendMessage).toHaveBeenCalledWith("987654@lid", {
          react: {
            text: "👍",
            key: {
              remoteJid: "987654@lid",
              id: "msg-2",
              fromMe: true,
              participant: participant ? "1999@s.whatsapp.net" : undefined,
            },
          },
        });
      },
    );

    it("resolves PN to LID for sendComposingTo presence", async () => {
      await api.sendComposingTo("+15555550000");
      expect(sendPresenceUpdate).toHaveBeenCalledWith("composing", "987654@lid");
    });

    it("skips newsletter composing presence when authDir is provided", async () => {
      await api.sendComposingTo("120363401234567890@newsletter");
      expect(sendPresenceUpdate).not.toHaveBeenCalled();
    });
  });
});

describe("WhatsApp send receipts", () => {
  it("rejects empty send batches instead of fabricating an unknown receipt", () => {
    expect(() => combineWhatsAppSendResults("text", [])).toThrow(PlatformMessageNotDispatchedError);
  });

  it("enriches nested partial receipts from canonical accepted metadata", () => {
    const key = {
      id: "accepted",
      remoteJid: DM_JID,
      fromMe: true,
      participant: "456@s.whatsapp.net",
    };
    const accepted = normalizeWhatsAppSendResult({ key }, "text");
    const receipt = accepted.receipt;
    if (!receipt) {
      throw new Error("missing provider receipt");
    }
    const context = { threadId: "thread", replyToId: "reply" };
    const tokens = { editToken: "edit", deleteToken: "delete" };
    accepted.receipt = {
      ...receipt,
      ...context,
      ...tokens,
      parts: receipt.parts.map((part) => Object.assign({}, part, { index: 7, ...context })),
    };
    const raw = { channel: "whatsapp", messageId: key.id };
    const incomplete = {
      ...accepted.receipt,
      raw: [raw],
      parts: accepted.receipt.parts.map((part) => ({ ...part, raw })),
    };
    const cause = new Error("provider bookkeeping failed");
    const delivery = { messageIds: [key.id], receipt: incomplete, visibleReplySent: true as const };
    const partial = createChannelPartialDeliveryError(cause, delivery);
    const wrapped = createChannelPartialDeliveryError(partial, delivery);
    const enriched = mergeWhatsAppAcceptedSendError({
      error: wrapped,
      kind: "text",
      results: [accepted],
    });
    expect(isChannelPartialDeliveryError(enriched)).toBe(true);
    expect(enriched).not.toBe(wrapped);
    const expectedRaw = {
      ...raw,
      toJid: DM_JID,
      meta: { fromMe: true, participant: key.participant },
    };
    expect(enriched).toMatchObject({
      cause,
      sentBeforeError: true,
      visibleReplySent: true,
      deliveryResult: {
        receipt: {
          primaryPlatformMessageId: key.id,
          platformMessageIds: [key.id],
          ...context,
          ...tokens,
          raw: [expectedRaw],
          parts: [
            { platformMessageId: key.id, kind: "text", index: 7, ...context, raw: expectedRaw },
          ],
        },
      },
    });
  });
});
