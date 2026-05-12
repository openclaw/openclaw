import type { proto, WAMessage } from "baileys";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { createWaSocket } from "../session.js";
import { extractContextInfo } from "./extract.js";
import { downloadMediaMessage, normalizeMessageContent } from "./runtime-api.js";

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

type MediaByteStream = AsyncIterable<unknown> & {
  destroy?: () => void;
};

class WhatsAppInboundMediaLimitExceededError extends Error {
  constructor(limit: number) {
    super(`WhatsApp inbound media exceeds ${limit} byte limit`);
    this.name = "WhatsAppInboundMediaLimitExceededError";
  }
}

function normalizeMediaChunk(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  if (chunk instanceof ArrayBuffer) {
    return Buffer.from(chunk);
  }
  if (typeof chunk === "string") {
    return Buffer.from(chunk);
  }
  throw new Error("Unexpected WhatsApp media stream chunk");
}

async function readMediaStream(stream: MediaByteStream, maxBytes?: number): Promise<Buffer> {
  const limit =
    typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes >= 0
      ? maxBytes
      : undefined;
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    const buffer = normalizeMediaChunk(chunk);
    totalBytes += buffer.byteLength;
    if (limit !== undefined && totalBytes > limit) {
      stream.destroy?.();
      throw new WhatsAppInboundMediaLimitExceededError(limit);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes);
}

export async function downloadInboundMedia(
  msg: proto.IWebMessageInfo,
  sock: Awaited<ReturnType<typeof createWaSocket>>,
  maxBytes?: number,
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
    const stream = await downloadMediaMessage(
      msg as WAMessage,
      "stream",
      {},
      {
        reuploadRequest: sock.updateMediaMessage,
        logger: sock.logger,
      },
    );
    const buffer = await readMediaStream(stream, maxBytes);
    return { buffer, mimetype, fileName };
  } catch (err) {
    if (err instanceof WhatsAppInboundMediaLimitExceededError) {
      throw err;
    }
    logVerbose(`downloadMediaMessage failed: ${String(err)}`);
    return undefined;
  }
}

export async function downloadQuotedInboundMedia(
  msg: proto.IWebMessageInfo,
  sock: Awaited<ReturnType<typeof createWaSocket>>,
  maxBytes?: number,
): Promise<{ buffer: Buffer; mimetype?: string; fileName?: string } | undefined> {
  const message = unwrapMessage(msg.message as proto.IMessage | undefined);
  const contextInfo = extractContextInfo(message);
  if (!contextInfo?.quotedMessage) {
    return undefined;
  }
  const quotedMessage = contextInfo.quotedMessage;
  return downloadInboundMedia(
    {
      key: {
        id: contextInfo?.stanzaId || undefined,
        remoteJid: contextInfo.remoteJid ?? msg.key?.remoteJid ?? undefined,
        participant: contextInfo?.participant ?? undefined,
        fromMe: false,
      },
      message: quotedMessage,
      messageTimestamp: msg.messageTimestamp,
    },
    sock,
    maxBytes,
  );
}
