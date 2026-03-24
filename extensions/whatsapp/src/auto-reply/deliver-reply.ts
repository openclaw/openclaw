import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-runtime";
import {
  resolveOutboundMediaUrls,
  sendMediaWithLeadingCaption,
} from "openclaw/plugin-sdk/reply-payload";
import { chunkMarkdownTextWithMode, type ChunkMode } from "openclaw/plugin-sdk/reply-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-runtime";
import { markdownToWhatsApp } from "openclaw/plugin-sdk/text-runtime";
import { loadWebMedia } from "../media.js";
import {
  DEFAULT_RECONNECT_POLICY,
  newConnectionId,
  sleepWithAbort,
  type ReconnectPolicy,
} from "../reconnect.js";
import { formatError } from "../session.js";
import { whatsappOutboundLog } from "./loggers.js";
import type { WebInboundMsg } from "./types.js";
import { elide } from "./util.js";

const REASONING_PREFIX = "reasoning:";
type RetryStrategy = {
  maxAttempts: number;
  baseMs: number;
  factor: number;
  maxMs?: number;
};

const STANDARD_RETRY: RetryStrategy = { maxAttempts: 3, baseMs: 500, factor: 1 };
const MIN_DISCONNECT_RETRY_BUDGET_MS = 62_000;
const MIN_DISCONNECT_BASE_MS = 2_000;

function mergeAbortSignals(
  a?: AbortSignal,
  b?: AbortSignal,
): { signal?: AbortSignal; dispose: () => void } {
  if (!a && !b) {
    return { signal: undefined, dispose: () => {} };
  }
  if (!a) {
    return { signal: b, dispose: () => {} };
  }
  if (!b) {
    return { signal: a, dispose: () => {} };
  }
  const controller = new AbortController();
  const abortFrom = (source: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(source.reason);
    }
  };
  if (a.aborted) {
    abortFrom(a);
    return { signal: controller.signal, dispose: () => {} };
  }
  if (b.aborted) {
    abortFrom(b);
    return { signal: controller.signal, dispose: () => {} };
  }
  const onAbortA = () => abortFrom(a);
  const onAbortB = () => abortFrom(b);
  a.addEventListener("abort", onAbortA, { once: true });
  b.addEventListener("abort", onAbortB, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      a.removeEventListener("abort", onAbortA);
      b.removeEventListener("abort", onAbortB);
    },
  };
}

function resolveReconnectPolicy(msg: WebInboundMsg): ReconnectPolicy {
  const initialMs = Math.max(
    250,
    msg.disconnectRetryPolicy?.initialMs ?? DEFAULT_RECONNECT_POLICY.initialMs,
  );
  const maxMs = Math.max(
    initialMs,
    msg.disconnectRetryPolicy?.maxMs ?? DEFAULT_RECONNECT_POLICY.maxMs,
  );
  const factor = Math.min(
    10,
    Math.max(1.1, msg.disconnectRetryPolicy?.factor ?? DEFAULT_RECONNECT_POLICY.factor),
  );
  const jitter = Math.min(
    1,
    Math.max(0, msg.disconnectRetryPolicy?.jitter ?? DEFAULT_RECONNECT_POLICY.jitter),
  );
  const maxAttempts = Math.max(
    0,
    Math.floor(msg.disconnectRetryPolicy?.maxAttempts ?? DEFAULT_RECONNECT_POLICY.maxAttempts),
  );
  return { initialMs, maxMs, factor, jitter, maxAttempts };
}

function computeReconnectDelayCeiling(policy: ReconnectPolicy, attempt: number): number {
  const baseDelayMs = policy.initialMs * policy.factor ** Math.max(attempt - 1, 0);
  const withJitterCeilingMs = baseDelayMs * (1 + policy.jitter);
  return Math.min(policy.maxMs, Math.round(withJitterCeilingMs));
}

function resolveReconnectSleepAttempts(policy: ReconnectPolicy): number {
  if (policy.maxAttempts > 0) {
    return Math.max(0, policy.maxAttempts - 1);
  }
  return Number.POSITIVE_INFINITY;
}

function resolveCappedBackoffPrefixAttempts(
  initialMs: number,
  factor: number,
  maxMs: number,
): number {
  if (!(initialMs < maxMs)) {
    return 0;
  }
  return Math.max(0, Math.floor(Math.log(maxMs / initialMs) / Math.log(factor)) + 1);
}

function sumCappedBackoffBudgetMs(
  initialMs: number,
  factor: number,
  maxMs: number,
  attempts: number,
): number {
  if (attempts <= 0) {
    return 0;
  }
  const prefixAttempts = Math.min(
    attempts,
    resolveCappedBackoffPrefixAttempts(initialMs, factor, maxMs),
  );
  let totalMs = 0;
  for (let attempt = 0; attempt < prefixAttempts; attempt++) {
    totalMs += Math.min(maxMs, Math.round(initialMs * factor ** attempt));
  }
  if (prefixAttempts < attempts) {
    totalMs += (attempts - prefixAttempts) * maxMs;
  }
  return totalMs;
}

function countCappedBackoffSleepsForBudget(
  initialMs: number,
  factor: number,
  maxMs: number,
  budgetMs: number,
): number {
  if (budgetMs <= 0) {
    return 0;
  }
  const prefixAttempts = resolveCappedBackoffPrefixAttempts(initialMs, factor, maxMs);
  let totalMs = 0;
  for (let attempt = 0; attempt < prefixAttempts; attempt++) {
    totalMs += Math.min(maxMs, Math.round(initialMs * factor ** attempt));
    if (totalMs >= budgetMs) {
      return attempt + 1;
    }
  }
  return prefixAttempts + Math.ceil(Math.max(0, budgetMs - totalMs) / maxMs);
}

export function resolveDisconnectRetryStrategy(msg: WebInboundMsg): RetryStrategy {
  const reconnectPolicy = resolveReconnectPolicy(msg);
  const baseMs = Math.max(MIN_DISCONNECT_BASE_MS, reconnectPolicy.initialMs);
  const maxMs = Math.max(baseMs, reconnectPolicy.maxMs);
  const factor = Math.max(1.1, reconnectPolicy.factor);
  const reconnectSleepAttempts = resolveReconnectSleepAttempts(reconnectPolicy);
  if (!Number.isFinite(reconnectSleepAttempts)) {
    return {
      maxAttempts: Number.POSITIVE_INFINITY,
      baseMs,
      factor,
      maxMs,
    };
  }
  const retryBudgetMs = Math.max(
    MIN_DISCONNECT_RETRY_BUDGET_MS,
    sumCappedBackoffBudgetMs(
      reconnectPolicy.initialMs * (1 + reconnectPolicy.jitter),
      reconnectPolicy.factor,
      reconnectPolicy.maxMs,
      reconnectSleepAttempts,
    ),
  );
  const sleepCount = countCappedBackoffSleepsForBudget(baseMs, factor, maxMs, retryBudgetMs);

  return {
    maxAttempts: 2 + sleepCount,
    baseMs,
    factor,
    maxMs,
  };
}

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
  const convertedText = markdownToWhatsApp(
    convertMarkdownTables(replyResult.text || "", tableMode),
  );
  const textChunks = chunkMarkdownTextWithMode(convertedText, textLimit, chunkMode);
  const mediaList = resolveOutboundMediaUrls(replyResult);

  // Standard retry: 3 attempts with short linear backoff.
  // If disconnect-class errors appear, escalate to a reconnect-aware retry
  // window sized from the active reconnect policy.
  const STANDARD = STANDARD_RETRY;
  const DISCONNECT = resolveDisconnectRetryStrategy(msg);

  const sendWithRetry = async (fn: () => Promise<unknown>, label: string) => {
    let lastErr: unknown;
    let strategy = STANDARD;
    let maxAttempts = strategy.maxAttempts;
    let disconnectSleepAttempt = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const errText = formatError(err);
        const isDisconnect = /closed|reset|timed\s*out|disconnect|no active socket/i.test(errText);
        const isReconnectGap = /no active socket|reconnection in progress/i.test(errText);
        const useDisconnectWindow = isReconnectGap || msg.disconnectRetryWindowActive?.() === true;
        if (isReconnectGap && msg.shouldRetryDisconnect?.() === false) {
          throw err;
        }
        const shouldPromoteDisconnectRetries = strategy === STANDARD && useDisconnectWindow;
        const latePromotion = shouldPromoteDisconnectRetries && attempt > 1;
        if (latePromotion) {
          strategy = DISCONNECT;
          maxAttempts = DISCONNECT.maxAttempts;
          disconnectSleepAttempt = 0;
        }
        const isLast = attempt >= maxAttempts;
        if (!isDisconnect || isLast) {
          throw err;
        }

        const backoffMs =
          strategy.factor === 1
            ? strategy.baseMs * attempt
            : Math.min(
                strategy.maxMs ?? Number.POSITIVE_INFINITY,
                Math.round(strategy.baseMs * Math.pow(strategy.factor, disconnectSleepAttempt)),
              );

        if (strategy === DISCONNECT) {
          disconnectSleepAttempt += 1;
        }

        if (shouldPromoteDisconnectRetries && !latePromotion) {
          strategy = DISCONNECT;
          maxAttempts = DISCONNECT.maxAttempts;
        }

        logVerbose(
          `Retrying ${label} to ${msg.from} after failure (${attempt}/${maxAttempts}) in ${backoffMs}ms: ${errText}`,
        );
        const wakeSignal = msg.disconnectRetryWakeSignal?.();
        const mergedSleepAbort = mergeAbortSignals(msg.disconnectRetryAbortSignal, wakeSignal);
        try {
          await sleepWithAbort(backoffMs, mergedSleepAbort.signal);
        } catch (sleepErr) {
          if (msg.disconnectRetryAbortSignal?.aborted || msg.shouldRetryDisconnect?.() === false) {
            throw err;
          }
          if (wakeSignal?.aborted) {
            continue;
          }
          throw sleepErr;
        } finally {
          mergedSleepAbort.dispose();
        }
      }
    }
    throw lastErr;
  };

  // Text-only replies
  if (mediaList.length === 0 && textChunks.length) {
    const totalChunks = textChunks.length;
    for (const [index, chunk] of textChunks.entries()) {
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
  const leadingCaption = remainingText.shift() || "";
  await sendMediaWithLeadingCaption({
    mediaUrls: mediaList,
    caption: leadingCaption,
    send: async ({ mediaUrl, caption }) => {
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
    },
    onError: async ({ error, mediaUrl, caption, isFirst }) => {
      whatsappOutboundLog.error(`Failed sending web media to ${msg.from}: ${formatError(error)}`);
      replyLogger.warn({ err: error, mediaUrl }, "failed to send web media reply");
      if (!isFirst) {
        return;
      }
      const warning =
        error instanceof Error ? `⚠️ Media failed: ${error.message}` : "⚠️ Media failed.";
      const fallbackTextParts = [remainingText.shift() ?? caption ?? "", warning].filter(Boolean);
      const fallbackText = fallbackTextParts.join("\n");
      if (!fallbackText) {
        return;
      }
      whatsappOutboundLog.warn(`Media skipped; sent text-only to ${msg.from}`);
      await sendWithRetry(() => msg.reply(fallbackText), "text:fallback");
    },
  });

  // Remaining text chunks after media
  for (const chunk of remainingText) {
    await sendWithRetry(() => msg.reply(chunk), "text:remaining");
  }
}
