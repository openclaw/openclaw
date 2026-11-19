import type { proto, WAMessage } from "baileys";
import { saveMediaStream, type SavedMedia } from "openclaw/plugin-sdk/media-store";
import { identitiesOverlap } from "../identity.js";
import type { createWaSocket } from "../session.js";
import { extractContextInfo } from "./extract.js";
import { resolveInboundMediaMimetype } from "./media-mimetype.js";
import { downloadMediaMessage, normalizeMessageContent } from "./runtime-api.js";

// WhatsApp Web and Desktop can put media urls on hosts with no DNS record. Baileys rc14
// builds the directPath download on the url host, so these use the socket's media host
// until Baileys falls back on its own.
const NON_MEDIA_URL_HOSTS = new Set(["a.whatsapp.net", "web.whatsapp.net"]);

export async function downloadInboundMedia(
  msg: proto.IWebMessageInfo,
  sock: Awaited<ReturnType<typeof createWaSocket>>,
  maxBytes = 50 * 1024 * 1024,
  normalizedMessage?: proto.IMessage,
): Promise<{ saved: SavedMedia; mimetype?: string; fileName?: string } | undefined> {
  const message = normalizedMessage ?? normalizeMessageContent(msg.message);
  if (!message) {
    return undefined;
  }
  const mimetype = resolveInboundMediaMimetype(message);
  const fileName = message.documentMessage?.fileName ?? undefined;
  const media =
    message.imageMessage ??
    message.videoMessage ??
    message.ptvMessage ??
    message.documentMessage ??
    message.audioMessage ??
    message.stickerMessage;
  if (!media) {
    return undefined;
  }
  const urlHost = media.url ? URL.parse(media.url)?.hostname : undefined;
  const stream = await downloadMediaMessage(
    msg as WAMessage,
    "stream",
    urlHost && NON_MEDIA_URL_HOSTS.has(urlHost) ? { host: sock.getMediaHost() } : {},
    {
      reuploadRequest: sock.updateMediaMessage,
      logger: sock.logger,
    },
  );
  const saved = await saveMediaStream(
    stream as AsyncIterable<unknown>,
    mimetype,
    "inbound",
    maxBytes,
    fileName,
  );
  return { saved, mimetype, fileName };
}

export async function downloadQuotedInboundMedia(
  msg: proto.IWebMessageInfo,
  sock: Awaited<ReturnType<typeof createWaSocket>>,
  maxBytes = 50 * 1024 * 1024,
): Promise<{ saved: SavedMedia; mimetype?: string; fileName?: string } | undefined> {
  const message = normalizeMessageContent(msg.message);
  const contextInfo = extractContextInfo(message);
  if (!contextInfo?.quotedMessage) {
    return undefined;
  }
  const quotedMessage = contextInfo.quotedMessage;
  const self = sock.user;
  // Baileys copies fromMe into the media-reupload receipt; own quoted media must retain its author.
  const quotedFromMe = identitiesOverlap(
    { jid: contextInfo.participant },
    { jid: self?.id, lid: self?.lid, e164: self?.phoneNumber },
  );
  return downloadInboundMedia(
    {
      key: {
        id: contextInfo?.stanzaId || undefined,
        remoteJid: contextInfo.remoteJid ?? msg.key?.remoteJid ?? undefined,
        participant: contextInfo?.participant ?? undefined,
        fromMe: quotedFromMe,
      },
      message: quotedMessage,
      messageTimestamp: msg.messageTimestamp,
    },
    sock,
    maxBytes,
  );
}
