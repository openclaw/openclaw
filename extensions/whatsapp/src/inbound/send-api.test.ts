import fs from "node:fs";
import path from "node:path";
import type { WAMessage } from "baileys";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { listMessageReceiptPlatformIds } from "openclaw/plugin-sdk/channel-outbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
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
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
  function expectPartial(failure: unknown, ids: string[], cause: unknown) {
    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    expect(failure).toMatchObject({
      cause,
      deliveryResult: { messageIds: ids, receipt: { platformMessageIds: ids } },
    });
    expect(sendMessage).toHaveBeenCalledOnce();
    expectOutboundActivityOnce();
  }
  function expectSend(fields: Record<string, unknown>, jid = DM_JID) {
    expect(sendMessage.mock.calls[0]?.slice(0, 2)).toMatchObject([jid, fields]);
  }

  function expectAccepted(result: WhatsAppSendResult, kind: string, messageId = "msg-1") {
    expect(result).toMatchObject({ kind, messageId, providerAccepted: true });
  }

  function expectOutboundActivityOnce() {
    expect(recordChannelActivity).toHaveBeenCalledExactlyOnceWith({
      channel: "whatsapp",
      accountId: "main",
      direction: "outbound",
    });
  }
  const voice = () => api.sendMessage("+1555", "voice text", MEDIA, "audio/ogg");

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
    [phone, "cap @15551234567", "cap @15551234567", [PN]],
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

  it.each([
    ["video", " Video/MP4; charset=binary ", "video/mp4", undefined, {}],
    ["video", "video/mp4", "video/mp4", { gifPlayback: true }, { gifPlayback: true }],
    ["document", undefined, "application/octet-stream", undefined, {}],
    ["image", "image/jpeg", "image/jpeg", undefined, PREVIEW],
    [
      "document",
      "image/jpeg",
      "image/jpeg",
      { asDocument: true, fileName: "promo.jpg" },
      { fileName: "promo.jpg" },
    ],
  ] as const)("sends %s media (%s)", async (kind, inputType, mimetype, options, fields) => {
    useMentions(mapped);
    if (kind === "image") {
      imageOps.getImageMetadata.mockResolvedValueOnce({ width: 640, height: 480 });
      imageOps.resizeToJpeg.mockResolvedValueOnce(THUMBNAIL);
    }
    const media = inputType
      ? await prepareWhatsAppOutboundMedia({ buffer: MEDIA, contentType: inputType })
      : { buffer: MEDIA, mimetype: undefined };
    await api.sendMessage(GROUP_JID, "cap " + source, media.buffer, media.mimetype, options);
    expectSend(
      { [kind]: MEDIA, caption: "cap " + target, mimetype, mentions: [LID_JID], ...fields },
      GROUP_JID,
    );
  });

  it("quotes both voice sends and combines their receipts", async () => {
    sendMessage
      .mockResolvedValueOnce(acceptedMessage("voice-1"))
      .mockResolvedValueOnce(acceptedMessage("voice-text-1"));
    const key = { id: "quoted-1", remoteJid: DM_JID, fromMe: true };
    const res = await api.sendMessage("+1555", "voice text", MEDIA, "audio/ogg", {
      quotedMessageKey: {
        ...key,
        remoteJid: LID_JID,
        lookupTargetJid: DM_JID,
        messageText: "quote",
      },
    });
    expect(sendMessage.mock.calls).toMatchObject([
      [DM_JID, { audio: MEDIA, ptt: true, mimetype: "audio/ogg" }, { quoted: { key } }],
      [DM_JID, { text: "voice text" }, { quoted: { key } }],
    ]);
    expectAccepted(res, "media", "voice-1");
    expect(res.receipt ? listMessageReceiptPlatformIds(res.receipt) : []).toEqual([
      "voice-1",
      "voice-text-1",
    ]);
    expectOutboundActivityOnce();
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
    expectPartial(await send().catch((caught: unknown) => caught), ["accepted"], activityError);
  });

  it("rejects an unaccepted Baileys voice send without recording outbound activity", async () => {
    sendMessage.mockResolvedValueOnce(undefined);
    await expect(api.sendMessage("+1555", "", MEDIA, "audio/ogg")).rejects.toBeInstanceOf(
      PlatformMessageNotDispatchedError,
    );
    expect(recordChannelActivity).not.toHaveBeenCalled();
  });

  // #67378: Missing LID resolution sends messages into a sender-only ghost chat.
  describe("createWebSendApi LID resolution (issue #67378)", () => {
    const { sendPresenceUpdate } = sock;
    beforeEach(() => {
      const authDir = tempDirs.make("openclaw-wa-lid-");
      fs.writeFileSync(path.join(authDir, "lid-mapping-15555550000.json"), '"987654"');
      api = createWebSendApi({ sock, defaultAccountId: "main", authDir });
    });

    it.each([undefined, "+1999"])(
      "resolves reaction JIDs with participant %s",
      async (participant) => {
        expectAccepted(
          await api.sendReaction("+15555550000", "msg-2", "👍", true, participant),
          "reaction",
        );
        const normalized = participant ? "1999@s.whatsapp.net" : undefined;
        const key = { remoteJid: "987654@lid", id: "msg-2", fromMe: true, participant: normalized };
        expect(sendMessage).toHaveBeenCalledWith("987654@lid", { react: { text: "👍", key } });
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
  it("rejects empty send batches instead of fabricating an unknown receipt", () => {
    expect(() => combineWhatsAppSendResults("text", [])).toThrow(PlatformMessageNotDispatchedError);
  });

  it("enriches nested partial receipts from canonical accepted metadata", () => {
    const participant = "456@s.whatsapp.net";
    const key = { id: "accepted", remoteJid: DM_JID, fromMe: true, participant };
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
    expect(receipt.raw).toEqual([
      { ...raw, toJid: DM_JID, meta: { fromMe: true, participant: key.participant } },
    ]);
    expect(enriched).toMatchObject({
      cause,
      sentBeforeError: true,
      visibleReplySent: true,
      deliveryResult: { receipt: accepted.receipt },
    });
  });
});
