import { chunkMarkdownTextWithMode, type ChunkMode } from "../../../../src/auto-reply/chunk.js";
import type { ReplyPayload } from "../../../../src/auto-reply/types.js";
import type { MarkdownTableMode } from "../../../../src/config/types.base.js";
import { logVerbose, shouldLogVerbose } from "../../../../src/globals.js";
import { convertMarkdownTables } from "../../../../src/markdown/tables.js";
import { markdownToWhatsApp } from "../../../../src/markdown/whatsapp.js";
import { sleep } from "../../../../src/utils.js";
import { loadWebMedia } from "../media.js";
import { newConnectionId } from "../reconnect.js";
import { formatError } from "../session.js";
import { whatsappOutboundLog } from "./loggers.js";
import type { WebInboundMsg } from "./types.js";
import { elide } from "./util.js";

const REASONING_PREFIX = "reasoning:";

function shouldSuppressReasoningReply(payload: ReplyPayload): boolean {
  if (payload.isReasoning === true) {
    return true;
  }
  const text = payload.text;
  if (typeof text !== "string") {
    return false;
  }
  return text.trimStart().toLowerCase().startsWith(REASONING_PREFIX);
}

export async function deliverWebReply(params: {
  replyResult: ReplyPayload;
  msg: WebInboundMsg;
  mediaLocalRoots?: readonly string[];
  maxMediaBytes: number;
  textLimit: number;
  chunkMode?: ChunkMode;
  replyLogger: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
  };
  connectionId?: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  skipLog?: boolean;
  tableMode?: MarkdownTableMode;
}) {
  const { replyResult, msg, maxMediaBytes, textLimit, replyLogger, connectionId, skipLog } = params;
  const replyStarted = Date.now();
  if (shouldSuppressReasoningReply(replyResult)) {
    whatsappOutboundLog.debug(`Suppressed reasoning payload to ${msg.from}`);
    return;
  }
  const tableMode = params.tableMode ?? "code";
  const chunkMode = params.chunkMode ?? "length";
  const abortController =
    params.abortSignal || params.timeoutMs ? new AbortController() : undefined;
  const abortSignal = abortController?.signal ?? params.abortSignal;
  let timeoutHandle: NodeJS.Timeout | undefined;
  let upstreamAbortListener: (() => void) | undefined;
  if (abortController && params.abortSignal) {
    upstreamAbortListener = () => {
      abortController.abort(params.abortSignal?.reason);
    };
    if (params.abortSignal.aborted) {
      upstreamAbortListener();
    } else {
      params.abortSignal.addEventListener("abort", upstreamAbortListener, { once: true });
    }
  }
  if (abortController && params.timeoutMs && params.timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      const timeoutError = new Error(`delivery timed out after ${params.timeoutMs}ms`);
      timeoutError.name = "AbortError";
      abortController.abort(timeoutError);
    }, params.timeoutMs);
  }
  const throwIfAborted = () => {
    if (abortSignal?.aborted) {
      throw abortSignal.reason instanceof Error
        ? abortSignal.reason
        : new Error(String(abortSignal.reason ?? "aborted"));
    }
  };
  const sleepWithAbort = async (ms: number) => {
    throwIfAborted();
    if (!abortSignal) {
      await sleep(ms);
      return;
    }
    let abortListener: (() => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      abortListener = () => {
        reject(
          abortSignal.reason instanceof Error
            ? abortSignal.reason
            : new Error(String(abortSignal.reason ?? "aborted")),
        );
      };
      abortSignal.addEventListener("abort", abortListener, { once: true });
    });
    try {
      await Promise.race([sleep(ms), abortPromise]);
    } finally {
      if (abortListener) {
        abortSignal.removeEventListener("abort", abortListener);
      }
    }
  };
  const awaitSendWithAbort = async <T>(fn: () => Promise<T>): Promise<T> => {
    throwIfAborted();
    const sendPromise = Promise.resolve().then(fn);
    if (!abortSignal) {
      return await sendPromise;
    }
    let abortListener: (() => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      abortListener = () => {
        reject(
          abortSignal.reason instanceof Error
            ? abortSignal.reason
            : new Error(String(abortSignal.reason ?? "aborted")),
        );
      };
      abortSignal.addEventListener("abort", abortListener, { once: true });
    });
    try {
      // We cannot cancel the underlying provider send, but we can stop waiting on it so
      // commentary delivery and final fallback behavior are not pinned behind a hung call.
      return await Promise.race([sendPromise, abortPromise]);
    } finally {
      if (abortListener) {
        abortSignal.removeEventListener("abort", abortListener);
      }
    }
  };
  const convertedText = markdownToWhatsApp(
    convertMarkdownTables(replyResult.text || "", tableMode),
  );
  const textChunks = chunkMarkdownTextWithMode(convertedText, textLimit, chunkMode);
  const mediaList = replyResult.mediaUrls?.length
    ? replyResult.mediaUrls
    : replyResult.mediaUrl
      ? [replyResult.mediaUrl]
      : [];

  const sendWithRetry = async (fn: () => Promise<unknown>, label: string, maxAttempts = 3) => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      throwIfAborted();
      try {
        return await awaitSendWithAbort(fn);
      } catch (err) {
        lastErr = err;
        if (abortSignal?.aborted) {
          throw err;
        }
        const errText = formatError(err);
        const isLast = attempt === maxAttempts;
        const shouldRetry = /closed|reset|timed\s*out|disconnect/i.test(errText);
        if (!shouldRetry || isLast) {
          throw err;
        }
        const backoffMs = 500 * attempt;
        logVerbose(
          `Retrying ${label} to ${msg.from} after failure (${attempt}/${maxAttempts - 1}) in ${backoffMs}ms: ${errText}`,
        );
        await sleepWithAbort(backoffMs);
      }
    }
    throw lastErr;
  };

  try {
    // Text-only replies
    if (mediaList.length === 0 && textChunks.length) {
      const totalChunks = textChunks.length;
      for (const [index, chunk] of textChunks.entries()) {
        throwIfAborted();
        const chunkStarted = Date.now();
        await sendWithRetry(() => msg.reply(chunk), "text");
        if (!skipLog) {
          const durationMs = Date.now() - chunkStarted;
          whatsappOutboundLog.debug(
            `Sent chunk ${index + 1}/${totalChunks} to ${msg.from} (${durationMs.toFixed(0)}ms)`,
          );
        }
      }
      replyLogger.info(
        {
          correlationId: msg.id ?? newConnectionId(),
          connectionId: connectionId ?? null,
          to: msg.from,
          from: msg.to,
          text: elide(replyResult.text, 240),
          mediaUrl: null,
          mediaSizeBytes: null,
          mediaKind: null,
          durationMs: Date.now() - replyStarted,
        },
        "auto-reply sent (text)",
      );
      return;
    }

    const remainingText = [...textChunks];

    // Media (with optional caption on first item)
    for (const [index, mediaUrl] of mediaList.entries()) {
      throwIfAborted();
      const caption = index === 0 ? remainingText.shift() || undefined : undefined;
      try {
        const media = await loadWebMedia(mediaUrl, {
          maxBytes: maxMediaBytes,
          localRoots: params.mediaLocalRoots,
        });
        if (shouldLogVerbose()) {
          logVerbose(
            `Web auto-reply media size: ${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB`,
          );
          logVerbose(`Web auto-reply media source: ${mediaUrl} (kind ${media.kind})`);
        }
        if (media.kind === "image") {
          await sendWithRetry(
            () =>
              msg.sendMedia({
                image: media.buffer,
                caption,
                mimetype: media.contentType,
              }),
            "media:image",
          );
        } else if (media.kind === "audio") {
          await sendWithRetry(
            () =>
              msg.sendMedia({
                audio: media.buffer,
                ptt: true,
                mimetype: media.contentType,
                caption,
              }),
            "media:audio",
          );
        } else if (media.kind === "video") {
          await sendWithRetry(
            () =>
              msg.sendMedia({
                video: media.buffer,
                caption,
                mimetype: media.contentType,
              }),
            "media:video",
          );
        } else {
          const fileName = media.fileName ?? mediaUrl.split("/").pop() ?? "file";
          const mimetype = media.contentType ?? "application/octet-stream";
          await sendWithRetry(
            () =>
              msg.sendMedia({
                document: media.buffer,
                fileName,
                caption,
                mimetype,
              }),
            "media:document",
          );
        }
        whatsappOutboundLog.info(
          `Sent media reply to ${msg.from} (${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB)`,
        );
        replyLogger.info(
          {
            correlationId: msg.id ?? newConnectionId(),
            connectionId: connectionId ?? null,
            to: msg.from,
            from: msg.to,
            text: caption ?? null,
            mediaUrl,
            mediaSizeBytes: media.buffer.length,
            mediaKind: media.kind,
            durationMs: Date.now() - replyStarted,
          },
          "auto-reply sent (media)",
        );
      } catch (err) {
        if (abortSignal?.aborted) {
          throw err;
        }
        whatsappOutboundLog.error(`Failed sending web media to ${msg.from}: ${formatError(err)}`);
        replyLogger.warn({ err, mediaUrl }, "failed to send web media reply");
        if (index === 0) {
          const warning =
            err instanceof Error ? `⚠️ Media failed: ${err.message}` : "⚠️ Media failed.";
          const fallbackTextParts = [remainingText.shift() ?? caption ?? "", warning].filter(
            Boolean,
          );
          const fallbackText = fallbackTextParts.join("\n");
          if (fallbackText) {
            whatsappOutboundLog.warn(`Media skipped; sent text-only to ${msg.from}`);
            throwIfAborted();
            await awaitSendWithAbort(() => msg.reply(fallbackText));
          }
        }
      }
    }

    // Remaining text chunks after media
    for (const chunk of remainingText) {
      throwIfAborted();
      await awaitSendWithAbort(() => msg.reply(chunk));
    }
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (upstreamAbortListener && params.abortSignal) {
      params.abortSignal.removeEventListener("abort", upstreamAbortListener);
    }
  }
}
