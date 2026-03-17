import { downloadMediaMessage, normalizeMessageContent } from "@whiskeysockets/baileys";
import { logVerbose } from "../../../../src/globals.js";
function unwrapMessage(message) {
  const normalized = normalizeMessageContent(message);
  return normalized;
}
function resolveMediaMimetype(message) {
  const explicit = message.imageMessage?.mimetype ?? message.videoMessage?.mimetype ?? message.documentMessage?.mimetype ?? message.audioMessage?.mimetype ?? message.stickerMessage?.mimetype ?? void 0;
  if (explicit) {
    return explicit;
  }
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
  return void 0;
}
async function downloadInboundMedia(msg, sock) {
  const message = unwrapMessage(msg.message);
  if (!message) {
    return void 0;
  }
  const mimetype = resolveMediaMimetype(message);
  const fileName = message.documentMessage?.fileName ?? void 0;
  if (!message.imageMessage && !message.videoMessage && !message.documentMessage && !message.audioMessage && !message.stickerMessage) {
    return void 0;
  }
  try {
    const buffer = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      {
        reuploadRequest: sock.updateMediaMessage,
        logger: sock.logger
      }
    );
    return { buffer, mimetype, fileName };
  } catch (err) {
    logVerbose(`downloadMediaMessage failed: ${String(err)}`);
    return void 0;
  }
}
export {
  downloadInboundMedia
};
