// Whatsapp plugin module implements media behavior.
import type { proto, WAMessage } from "baileys";
import { saveMediaStream, type SavedMedia } from "openclaw/plugin-sdk/media-store";
import type { createWaSocket } from "../session.js";
import { extractContextInfo } from "./extract.js";
import { resolveInboundMediaMimetype } from "./media-mimetype.js";
import { downloadMediaMessage, normalizeMessageContent } from "./runtime-api.js";

/**
 * Default per-chunk idle timeout for WhatsApp inbound media downloads.
 * Matches Telegram `TELEGRAM_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000` so a stalled
 * Baileys media stream cannot block inbound dispatch indefinitely.
 */
const WHATSAPP_INBOUND_MEDIA_IDLE_TIMEOUT_MS = 30_000;

class WhatsAppInboundMediaLimitExceededError extends Error {
  constructor(maxBytes: number) {
    super(`Media exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`);
    this.name = "WhatsAppInboundMediaLimitExceededError";
  }
}

class WhatsAppInboundMediaTimeoutError extends Error {
  readonly chunkTimeoutMs: number;
  constructor(chunkTimeoutMs: number) {
    super(`WhatsApp media download stalled: no data received for ${chunkTimeoutMs}ms`);
    this.name = "WhatsAppInboundMediaTimeoutError";
    this.chunkTimeoutMs = chunkTimeoutMs;
  }
}

function destroySource(source: unknown) {
  const s = source as { destroy?: (err?: Error) => void };
  if (typeof s.destroy === "function") {
    s.destroy(new WhatsAppInboundMediaTimeoutError(0));
  }
}

// Bound each AsyncIterable `next()` so a stalled Baileys download cannot hang
// inbound dispatch. On timeout, destroy the source (if it supports destroy) so
// the underlying Readable/HTTP resource closes, then call `return()` without
// awaiting. Silence the losing `nextPromise` to avoid unhandledRejection.
//
// IMPORTANT: do NOT `await` iterator.return() in the finally block. Node
// Readable async-iterator `return()` hangs when the underlying source is
// stalled (the iterator waits for a `readable` event that never fires). The
// source is explicitly destroyed before reaching the finally block so the
// underlying resource is released regardless.
function withChunkIdleTimeout<T>(
  source: AsyncIterable<T>,
  chunkTimeoutMs: number,
): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]();
      try {
        while (true) {
          const nextPromise = iterator.next();
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new WhatsAppInboundMediaTimeoutError(chunkTimeoutMs)),
              chunkTimeoutMs,
            );
          });
          let result: IteratorResult<T>;
          try {
            result = await Promise.race([nextPromise, timeoutPromise]);
          } catch (err) {
            // Destroy the source so the underlying Readable resource closes;
            // then silence the pending next() to avoid unhandledRejection.
            destroySource(source);
            nextPromise.then(
              () => undefined,
              () => undefined,
            );
            throw err;
          } finally {
            if (timeoutHandle !== undefined) {
              clearTimeout(timeoutHandle);
            }
          }
          if (result.done) {
            return;
          }
          yield result.value;
        }
      } finally {
        if (typeof iterator.return === "function") {
          iterator.return().catch(() => undefined);
        }
      }
    },
  };
}

function unwrapMessage(message: proto.IMessage | undefined): proto.IMessage | undefined {
  const normalized = normalizeMessageContent(message);
  return normalized;
}

export async function downloadInboundMedia(
  msg: proto.IWebMessageInfo,
  sock: Awaited<ReturnType<typeof createWaSocket>>,
  maxBytes = 50 * 1024 * 1024,
  options?: { chunkTimeoutMs?: number },
): Promise<{ saved: SavedMedia; mimetype?: string; fileName?: string } | undefined> {
  const message = unwrapMessage(msg.message as proto.IMessage | undefined);
  if (!message) {
    return undefined;
  }
  const mimetype = resolveInboundMediaMimetype(message);
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
  const chunkTimeoutMs = options?.chunkTimeoutMs ?? WHATSAPP_INBOUND_MEDIA_IDLE_TIMEOUT_MS;
  const stream = await downloadMediaMessage(
    msg as WAMessage,
    "stream",
    {},
    {
      reuploadRequest: sock.updateMediaMessage,
      logger: sock.logger,
    },
  );
  const saved = await saveInboundMediaStreamWithIdleTimeout(
    stream as AsyncIterable<unknown>,
    mimetype,
    maxBytes,
    fileName,
    chunkTimeoutMs,
  ).catch((err: unknown) => {
    if (err instanceof Error && /Media exceeds/i.test(err.message)) {
      throw new WhatsAppInboundMediaLimitExceededError(maxBytes);
    }
    throw err;
  });
  return { saved, mimetype, fileName };
}

/**
 * Production idle-wrap for Baileys media streams. Exported so loopback proofs can
 * drive the exact save path without a live WhatsApp session.
 */
export function saveInboundMediaStreamWithIdleTimeout(
  stream: AsyncIterable<unknown>,
  contentType: string | undefined,
  maxBytes: number,
  fileName?: string,
  chunkTimeoutMs: number = WHATSAPP_INBOUND_MEDIA_IDLE_TIMEOUT_MS,
): Promise<SavedMedia> {
  return saveMediaStream(
    withChunkIdleTimeout(stream, chunkTimeoutMs),
    contentType,
    "inbound",
    maxBytes,
    fileName,
  );
}

export async function downloadQuotedInboundMedia(
  msg: proto.IWebMessageInfo,
  sock: Awaited<ReturnType<typeof createWaSocket>>,
  maxBytes = 50 * 1024 * 1024,
  options?: { chunkTimeoutMs?: number },
): Promise<{ saved: SavedMedia; mimetype?: string; fileName?: string } | undefined> {
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
    options,
  );
}
