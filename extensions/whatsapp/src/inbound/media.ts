import type { proto, WAMessage } from "@whiskeysockets/baileys";
import { downloadMediaMessage, normalizeMessageContent } from "@whiskeysockets/baileys";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { createWaSocket } from "../session.js";

function unwrapMessage(message: proto.IMessage | undefined): proto.IMessage | undefined {
  const normalized = normalizeMessageContent(message);
  return normalized;
}

/**
 * Resolve the MIME type for an inbound media message.
 * Falls back to WhatsApp's standard formats when Baileys omits the MIME.
 */
function resolveMediaMimetype(message: proto.IMessage): string | undefined {
  const explicit =
    message.imageMessage?.mimetype ??
    message.videoMessage?.mimetype ??
    message.documentMessage?.mimetype ??
    message.audioMessage?.mimetype ??
    message.stickerMessage?.mimetype ??
    undefined;
  if (explicit) {
    return explicit;
  }
  // WhatsApp voice messages (PTT) and audio use OGG Opus by default
  if (message.audioMessage) {
    return "audio/ogg; codecs=opus";
  }
  if (message.imageMessage) {
    return "image/jpeg";
  }
  if (message.videoMessage) {
    return "video/mp4";
  }
  if (message.stickerMessage) {
    return "image/webp";
  }
  return undefined;
}

/**
 * Download media from a quoted (reply-target) message.
 *
 * Quoted messages are embedded as `proto.IMessage` inside `contextInfo` —
 * they don't carry the full `WAMessage` envelope.  We wrap them into one
 * so Baileys' `downloadMediaMessage` can resolve the media URL.
 *
 * If the full download fails (e.g. media key expired), we fall back to the
 * low-resolution `jpegThumbnail` that WhatsApp always embeds in the quote.
 */
export async function downloadQuotedMedia(
  quotedMessage: proto.IMessage,
  sock: Awaited<ReturnType<typeof createWaSocket>>,
): Promise<{ buffer: Buffer; mimetype?: string; fileName?: string } | undefined> {
  const message = unwrapMessage(quotedMessage);
  if (!message) {
    return undefined;
  }
  const mimetype = resolveMediaMimetype(message);
  const fileName = message.documentMessage?.fileName ?? undefined;
  if (
    !message.imageMessage &&
    !message.videoMessage &&
    !message.documentMessage &&
    !message.audioMessage &&
    !message.stickerMessage
  ) {
    return undefined;
  }

  // Wrap into a WAMessage envelope so downloadMediaMessage can work
  const syntheticMsg: proto.IWebMessageInfo = {
    key: { remoteJid: "", fromMe: false, id: "" },
    message: quotedMessage,
  };

  try {
    const buffer = await downloadMediaMessage(
      syntheticMsg as WAMessage,
      "buffer",
      {},
      {
        reuploadRequest: sock.updateMediaMessage,
        logger: sock.logger,
      },
    );
    return { buffer, mimetype, fileName };
  } catch (err) {
    logVerbose(`downloadMediaMessage (quoted) failed: ${String(err)}, trying thumbnail fallback`);
  }

  // Fallback: use the embedded jpegThumbnail if available
  const thumbnail =
    message.imageMessage?.jpegThumbnail ??
    message.videoMessage?.jpegThumbnail ??
    message.stickerMessage?.pngThumbnail ??
    message.documentMessage?.jpegThumbnail;
  if (thumbnail && thumbnail.length > 0) {
    logVerbose(`Using thumbnail fallback for quoted media (${thumbnail.length} bytes)`);
    return {
      buffer: Buffer.from(thumbnail),
      mimetype: mimetype ?? "image/jpeg",
      fileName,
    };
  }

  return undefined;
}

export async function downloadInboundMedia(
  msg: proto.IWebMessageInfo,
  sock: Awaited<ReturnType<typeof createWaSocket>>,
): Promise<{ buffer: Buffer; mimetype?: string; fileName?: string } | undefined> {
  const message = unwrapMessage(msg.message as proto.IMessage | undefined);
  if (!message) {
    return undefined;
  }
  const mimetype = resolveMediaMimetype(message);
  const fileName = message.documentMessage?.fileName ?? undefined;
  if (
    !message.imageMessage &&
    !message.videoMessage &&
    !message.documentMessage &&
    !message.audioMessage &&
    !message.stickerMessage
  ) {
    return undefined;
  }
  try {
    const buffer = await downloadMediaMessage(
      msg as WAMessage,
      "buffer",
      {},
      {
        reuploadRequest: sock.updateMediaMessage,
        logger: sock.logger,
      },
    );
    return { buffer, mimetype, fileName };
  } catch (err) {
    logVerbose(`downloadMediaMessage failed: ${String(err)}`);
    return undefined;
  }
}
