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

function createSocket() {
  return {
    sendMessage: vi.fn<Parameters<typeof createWebSendApi>[0]["sock"]["sendMessage"]>(
      async () => ({ key: { id: "msg-1" } }) as WAMessage,
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

  function expectAccepted(result: WhatsAppSendResult, kind: string, messageId: string) {
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
  const failedVoice = () => voice().catch((caught: unknown) => caught);

  const vcard = "BEGIN:VCARD\nFN:QA Contact\nEND:VCARD";
  const contact = Object.freeze({ displayName: "QA Contact", vcard });
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
    expectAccepted(await send(), kind, "msg-1");
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
  type MentionCase = [Participants, string, string, string[], ("image" | "document")?, string?];
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
    [phone, tagged, tagged, [], undefined, PN],
    [[{ id: "15550000000@s.whatsapp.net" }], tagged, tagged, []],
    [phone, "cap @15551234567", "cap @15551234567", [PN], "image"],
    [mapped, "cap " + source, "cap " + target, [LID_JID], "document"],
  ])(
    "native mentions %#",
    async (participants, text, expected, mentions, media, to = GROUP_JID) => {
      api = withMentions(participants);
      await api.sendMessage(
        to,
        text,
        media ? MEDIA : undefined,
        media ? "image/jpeg" : undefined,
        media === "document" ? { asDocument: true, fileName: "promo.jpg" } : undefined,
      );
      expectSend(
        {
          ...(media
            ? { [media]: MEDIA, caption: expected, mimetype: "image/jpeg" }
            : { text: expected }),
          ...(media === "document" ? { fileName: "promo.jpg" } : {}),
          ...(mentions.length ? { mentions } : {}),
        },
        to,
      );
      if (!mentions.length) {
        expect(sendMessage.mock.calls[0]?.[1]).not.toHaveProperty("mentions");
      }
    },
  );

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

  it("sends image thumbnails and dimensions", async () => {
    const thumbnail = Buffer.from("thumb");
    imageOps.getImageMetadata.mockResolvedValueOnce({ width: 640, height: 480 });
    imageOps.resizeToJpeg.mockResolvedValueOnce(thumbnail);
    await api.sendMessage("+1555", "cap", MEDIA, "image/png");
    expectSend({
      image: MEDIA,
      caption: "cap",
      mimetype: "image/png",
      jpegThumbnail: thumbnail.toString("base64"),
      width: 640,
      height: 480,
    });
  });

  it("sends voice text separately and combines both receipts", async () => {
    sendMessage
      .mockResolvedValueOnce({ key: { id: "voice-1" } })
      .mockResolvedValueOnce({ key: { id: "voice-text-1" } });
    const res = await voice();
    expectSend({ audio: MEDIA, ptt: true, mimetype: "audio/ogg" });
    expect(sendMessage).toHaveBeenNthCalledWith(2, DM_JID, {
      text: "voice text",
    });
    expectAccepted(res, "media", "voice-1");
    expect(res.receipt ? listMessageReceiptPlatformIds(res.receipt) : []).toEqual([
      "voice-1",
      "voice-text-1",
    ]);
    expectOutboundActivityOnce();
  });

  it("combines voice and nested partial-caption receipts", async () => {
    const bookkeepingError = new Error("caption bookkeeping failed");
    const acceptedCaption = normalizeWhatsAppSendResult(
      { key: { id: "caption" } } as WAMessage,
      "text",
    );
    sendMessage.mockResolvedValueOnce({ key: { id: "voice" } }).mockRejectedValueOnce(
      createChannelPartialDeliveryError(bookkeepingError, {
        messageIds: [acceptedCaption.messageId],
        receipt: acceptedCaption.receipt,
        visibleReplySent: true,
      }),
    );
    expectPartial(await failedVoice(), ["voice", "caption"], bookkeepingError, 2);
  });

  it("retains voice receipts when the caption is unaccepted", async () => {
    sendMessage.mockResolvedValueOnce({ key: { id: "voice" } }).mockResolvedValueOnce(undefined);
    expectPartial(await failedVoice(), ["voice"], expect.any(PlatformMessageNotDispatchedError), 2);
  });

  it.each([
    ["poll", () => api.sendPoll("+1555", { question: "Q?", options: ["a", "b"] })],
    ["voice", voice],
  ] as const)(
    "retains the first accepted %s receipt when activity recording fails",
    async (kind, send) => {
      const activityError = new Error("channel activity bookkeeping disconnected");
      sendMessage.mockResolvedValueOnce({ key: { id: `${kind}-accepted` } });
      recordChannelActivity.mockImplementationOnce(() => {
        throw activityError;
      });

      expectPartial(
        await send().catch((caught: unknown) => caught),
        [`${kind}-accepted`],
        activityError,
        1,
      );
    },
  );

  it("sends reactions with participant JID normalization", async () => {
    const res = await api.sendReaction("+1555", "msg-2", "👍", false, "+1999");
    const key = {
      remoteJid: DM_JID,
      id: "msg-2",
      fromMe: false,
      participant: "1999@s.whatsapp.net",
    };
    expectSend({ react: { text: "👍", key } });
    expectAccepted(res, "reaction", "msg-1");
  });

  it("rejects an unaccepted Baileys voice send without recording outbound activity", async () => {
    sendMessage.mockResolvedValueOnce(undefined);
    await expect(
      api.sendMessage("+1555", "", Buffer.from("voice"), "audio/ogg"),
    ).rejects.toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(recordChannelActivity).not.toHaveBeenCalled();
  });

  it.each([
    ["preserves an unproven LID quote", false, undefined, LID_JID],
    ["aligns a lookup-proven LID quote", true, DM_JID, DM_JID],
  ] as const)("%s", async (_name, fromMe, lookupTargetJid, expectedJid) => {
    await api.sendMessage("+1555", "hello", undefined, undefined, {
      quotedMessageKey: {
        id: "quoted-1",
        remoteJid: LID_JID,
        fromMe,
        lookupTargetJid,
        participant: "1234@s.whatsapp.net",
        messageText: "quoted body",
      },
    });
    expect(sendMessage.mock.calls[0]?.slice(0, 2)).toEqual([DM_JID, { text: "hello" }]);
    expect(sendMessage.mock.calls[0]?.[2]).toHaveProperty(
      "quoted.key",
      expect.objectContaining({ remoteJid: expectedJid, id: "quoted-1", fromMe }),
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
    const accepted = normalizeWhatsAppSendResult({ key } as WAMessage, "text");
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
