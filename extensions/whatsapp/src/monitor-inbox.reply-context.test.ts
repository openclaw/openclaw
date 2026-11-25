// WhatsApp monitor inbox behavior split by ownership.
import fsSync from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  imageOps,
  nextMessageId,
  inboundMessage,
  installStreamsInboundMessageHooks,
} from "./monitor-inbox.streams-inbound-messages.test-support.js";
import {
  buildNotifyMessageUpsert,
  getAuthDir,
  startInboxMonitor,
  waitForMessageCalls,
  type InboxOnMessage,
} from "./monitor-inbox.test-harness.js";

function quotedMessageUpsert(id: string, text: string, contextInfo: Record<string, unknown>) {
  return {
    type: "notify",
    messages: [
      {
        key: { id, fromMe: false, remoteJid: "999@s.whatsapp.net" },
        message: { extendedTextMessage: { text, contextInfo } },
        messageTimestamp: 1_700_000_000,
        pushName: "Tester",
      },
    ],
  };
}

describe("web monitor inbox reply context", () => {
  installStreamsInboundMessageHooks();

  async function receive(
    upsert: ReturnType<typeof quotedMessageUpsert> | ReturnType<typeof buildNotifyMessageUpsert>,
  ) {
    const onMessage = vi.fn(async () => {});
    const monitor = await startInboxMonitor(onMessage as InboxOnMessage);
    monitor.sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 1);
    return { ...monitor, inbound: inboundMessage(onMessage) };
  }

  async function expectQuotedReplyContext(quotedMessage: unknown) {
    const onMessage = vi.fn(async (msg) => {
      await msg.platform.reply("pong");
    });

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const upsert = quotedMessageUpsert(nextMessageId("quoted"), "reply", {
      stanzaId: "q1",
      participant: "111@s.whatsapp.net",
      quotedMessage,
    });

    sock.ev.emit("messages.upsert", upsert);
    await waitForMessageCalls(onMessage, 1);

    const inbound = inboundMessage(onMessage);
    expect(inbound.quote).toMatchObject({
      id: "q1",
      body: "original",
      sender: { displayName: "+111" },
      context: {
        id: "q1",
        body: "original",
        sender: { jid: "111@s.whatsapp.net", e164: "+111", label: "+111" },
      },
    });
    expect(inbound.platform).toMatchObject({
      sender: { e164: "+999", name: "Tester" },
      self: { jid: "123@s.whatsapp.net", e164: "+123" },
    });
    expect(sock.sendMessage).toHaveBeenCalledWith(
      "999@s.whatsapp.net",
      { text: "pong" },
      expect.objectContaining({ messageId: expect.any(String) }),
    );

    await listener.close();
  }

  it("prepopulates image previews for inbound sendMedia replies", async () => {
    const { listener, sock, inbound } = await receive(
      buildNotifyMessageUpsert({
        id: nextMessageId("image-preview"),
        remoteJid: "999@s.whatsapp.net",
        text: "ping",
        timestamp: 1_700_000_000,
        pushName: "Tester",
      }),
    );
    const image = Buffer.from("img");
    const thumbnail = Buffer.from("thumb");
    imageOps.getImageMetadata.mockResolvedValueOnce({ width: 640, height: 480 });
    imageOps.resizeToJpeg.mockResolvedValueOnce(thumbnail);

    await inbound.platform.sendMedia({ image, caption: "cap", mimetype: "image/png" });

    expect(imageOps.resizeToJpeg).toHaveBeenCalledWith({
      buffer: image,
      maxSide: 32,
      quality: 50,
      withoutEnlargement: true,
    });
    expect(sock.sendMessage).toHaveBeenCalledWith(
      "999@s.whatsapp.net",
      {
        image,
        caption: "cap",
        mimetype: "image/png",
        width: 640,
        height: 480,
        jpegThumbnail: thumbnail.toString("base64"),
      },
      expect.objectContaining({ messageId: expect.any(String) }),
    );

    await listener.close();
  });

  it.each([
    { source: "Baileys", remoteJid: "999@lid", phone: "999", mapped: "999@lid" },
    { source: "auth directory", remoteJid: "555@lid", phone: "1555" },
    { source: "group Baileys", remoteJid: "123@g.us", phone: "444", mapped: "444@lid" },
  ])("resolves LID JIDs via $source", async ({ remoteJid, phone, mapped }) => {
    if (!mapped) {
      fsSync.writeFileSync(
        path.join(getAuthDir(), "lid-mapping-555_reverse.json"),
        JSON.stringify(phone),
      );
    }
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const mapping = sock.signalRepository.lidMapping.getPNForLID;
    if (mapped) {
      mapping.mockResolvedValueOnce(phone + ":0@s.whatsapp.net");
    }
    const group = remoteJid.endsWith("@g.us");
    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: nextMessageId("lid"),
        remoteJid,
        text: "ping",
        timestamp: 1_700_000_000,
        ...(group ? { participant: mapped } : { pushName: "Tester" }),
      }),
    );
    await waitForMessageCalls(onMessage, 1);
    if (mapped) {
      expect(mapping).toHaveBeenCalledWith(mapped);
      if (!group) {
        expect(mapping).toHaveBeenCalledTimes(1);
      }
    } else {
      expect(mapping).not.toHaveBeenCalled();
    }
    const inbound = inboundMessage(onMessage);
    expect(inbound.payload.body).toBe("ping");
    expect(inbound.admission?.conversation.id).toBe(group ? remoteJid : "+" + phone);
    if (group) {
      expect(inbound.platform.senderE164).toBe("+" + phone);
      expect(inbound.admission?.conversation.kind).toBe("group");
    } else {
      expect(inbound.platform.recipientJid).toBe("+123");
    }
    await listener.close();
  });

  it("captures reply context from quoted messages", async () => {
    await expectQuotedReplyContext({ conversation: "original" });
  });

  it("preserves native reply context when WhatsApp omits the quoted message", async () => {
    const { listener, inbound } = await receive(
      quotedMessageUpsert(nextMessageId("quoted-unavailable"), "yes", {
        stanzaId: "original-message",
        participant: "111@s.whatsapp.net",
      }),
    );

    expect(inbound.payload.body).toBe("yes");
    expect(inbound.quote).toMatchObject({
      id: "original-message",
      body: "[quoted message unavailable]",
      sender: { displayName: "+111", jid: "111@s.whatsapp.net", e164: "+111" },
    });

    await listener.close();
  });

  it.each([
    ["captures reply context from wrapped quoted messages", "viewOnceMessageV2Extension"],
    ["captures reply context from botInvokeMessage wrapped quoted messages", "botInvokeMessage"],
    [
      "captures reply context from groupMentionedMessage wrapped quoted messages",
      "groupMentionedMessage",
    ],
  ])("%s", async (_name, wrapper) => {
    await expectQuotedReplyContext({
      [wrapper]: { message: { conversation: "original" } },
    });
  });
});
