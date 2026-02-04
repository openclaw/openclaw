import { GrammyError } from "grammy";
import { logVerbose, warn } from "../../../../src/globals.js";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import { retryAsync } from "../../../../src/infra/retry.js";
import { fetchRemoteMedia } from "../../../../src/media/fetch.js";
import { saveMediaBuffer } from "../../../../src/media/store.js";
import { shouldRetryTelegramIpv4Fallback, type TelegramTransport } from "../fetch.js";
import { cacheSticker, getCachedSticker } from "../sticker-cache.js";
import { resolveTelegramMediaPlaceholder } from "./helpers.js";
import type { AnimationMetadata, StickerMetadata, TelegramContext } from "./types.js";

const FILE_TOO_BIG_RE = /file is too big/i;
const TELEGRAM_MEDIA_SSRF_POLICY = {
  // Telegram file downloads should trust api.telegram.org even when DNS/proxy
  // resolution maps to private/internal ranges in restricted networks.
  allowedHostnames: ["api.telegram.org"],
  allowRfc2544BenchmarkRange: true,
};

/**
 * Returns true if the error is Telegram's "file is too big" error.
 * This happens when trying to download files >20MB via the Bot API.
 * Unlike network errors, this is a permanent error and should not be retried.
 */
function isFileTooBigError(err: unknown): boolean {
  if (err instanceof GrammyError) {
    return FILE_TOO_BIG_RE.test(err.description);
  }
  return FILE_TOO_BIG_RE.test(formatErrorMessage(err));
}

/**
 * Returns true if the error is a transient network error that should be retried.
 * Returns false for permanent errors like "file is too big" (400 Bad Request).
 */
function isRetryableGetFileError(err: unknown): boolean {
  // Don't retry "file is too big" - it's a permanent 400 error
  if (isFileTooBigError(err)) {
    return false;
  }
  // Retry all other errors (network issues, timeouts, etc.)
  return true;
}

function resolveMediaFileRef(msg: TelegramContext["message"]) {
  return (
    msg.photo?.[msg.photo.length - 1] ??
    msg.video ??
    msg.video_note ??
    msg.document ??
    msg.audio ??
    msg.voice
  );
}

function resolveTelegramFileName(msg: TelegramContext["message"]): string | undefined {
  return (
    msg.document?.file_name ??
    msg.audio?.file_name ??
    msg.video?.file_name ??
    msg.animation?.file_name
  );
}

async function resolveTelegramFileWithRetry(
  ctx: TelegramContext,
): Promise<{ file_path?: string } | null> {
  try {
    return await retryAsync(() => ctx.getFile(), {
      attempts: 3,
      minDelayMs: 1000,
      maxDelayMs: 4000,
      jitter: 0.2,
      label: "telegram:getFile",
      shouldRetry: isRetryableGetFileError,
      onRetry: ({ attempt, maxAttempts }) =>
        logVerbose(`telegram: getFile retry ${attempt}/${maxAttempts}`),
    });
  } catch (err) {
    // Handle "file is too big" separately - Telegram Bot API has a 20MB download limit
    if (isFileTooBigError(err)) {
      logVerbose(
        warn(
          "telegram: getFile failed - file exceeds Telegram Bot API 20MB limit; skipping attachment",
        ),
      );
      return null;
    }
    // All retries exhausted — return null so the message still reaches the agent
    // with a type-based placeholder (e.g. <media:audio>) instead of being dropped.
    logVerbose(`telegram: getFile failed after retries: ${String(err)}`);
    return null;
  }
}

function resolveRequiredTelegramTransport(transport?: TelegramTransport): TelegramTransport {
  if (transport) {
    return transport;
  }
  const resolvedFetch = globalThis.fetch;
  if (!resolvedFetch) {
    throw new Error("fetch is not available; set channels.telegram.proxy in config");
  }
  return {
    fetch: resolvedFetch,
    sourceFetch: resolvedFetch,
  };
}

function resolveOptionalTelegramTransport(transport?: TelegramTransport): TelegramTransport | null {
  try {
    return resolveRequiredTelegramTransport(transport);
  } catch {
    return null;
  }
}

/** Default idle timeout for Telegram media downloads (30 seconds). */
const TELEGRAM_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

async function downloadAndSaveTelegramFile(params: {
  filePath: string;
  token: string;
  transport: TelegramTransport;
  maxBytes: number;
  telegramFileName?: string;
}) {
  const url = `https://api.telegram.org/file/bot${params.token}/${params.filePath}`;
  const fetched = await fetchRemoteMedia({
    url,
    fetchImpl: params.transport.sourceFetch,
    dispatcherPolicy: params.transport.pinnedDispatcherPolicy,
    fallbackDispatcherPolicy: params.transport.fallbackPinnedDispatcherPolicy,
    shouldRetryFetchError: shouldRetryTelegramIpv4Fallback,
    filePathHint: params.filePath,
    maxBytes: params.maxBytes,
    readIdleTimeoutMs: TELEGRAM_DOWNLOAD_IDLE_TIMEOUT_MS,
    ssrfPolicy: TELEGRAM_MEDIA_SSRF_POLICY,
  });
  const originalName = params.telegramFileName ?? fetched.fileName ?? params.filePath;
  return saveMediaBuffer(
    fetched.buffer,
    fetched.contentType,
    "inbound",
    params.maxBytes,
    originalName,
  );
}

async function resolveStickerMedia(params: {
  msg: TelegramContext["message"];
  ctx: TelegramContext;
  maxBytes: number;
  token: string;
  transport?: TelegramTransport;
}): Promise<
  | {
      path: string;
      contentType?: string;
      placeholder: string;
      stickerMetadata?: StickerMetadata;
    }
  | null
  | undefined
> {
  const { msg, ctx, maxBytes, token, transport } = params;
  if (!msg.sticker) {
    return undefined;
  }
  const sticker = msg.sticker;
  // For animated (TGS) and video (WEBM) stickers, return metadata-only (no image download)
  // so the agent still receives emoji/setName context instead of silently dropping the message.
  if (sticker.is_animated || sticker.is_video) {
    logVerbose("telegram: animated/video sticker - returning metadata-only (no media download)");
    const cached = sticker.file_unique_id ? getCachedSticker(sticker.file_unique_id) : null;
    return {
      path: "",
      contentType: undefined,
      placeholder: "<media:sticker>",
      stickerMetadata: {
        emoji: sticker.emoji ?? cached?.emoji ?? undefined,
        setName: sticker.set_name ?? cached?.setName ?? undefined,
        fileId: sticker.file_id ?? cached?.fileId ?? undefined,
        fileUniqueId: sticker.file_unique_id,
        cachedDescription: cached?.description,
      },
    };
  }
  if (!sticker.file_id) {
    return null;
  }

  try {
    const file = await resolveTelegramFileWithRetry(ctx);
    if (!file?.file_path) {
      logVerbose("telegram: getFile returned no file_path for sticker");
      return null;
    }
    const resolvedTransport = resolveOptionalTelegramTransport(transport);
    if (!resolvedTransport) {
      logVerbose("telegram: fetch not available for sticker download");
      return null;
    }
    const saved = await downloadAndSaveTelegramFile({
      filePath: file.file_path,
      token,
      transport: resolvedTransport,
      maxBytes,
    });

    // Check sticker cache for existing description
    const cached = sticker.file_unique_id ? getCachedSticker(sticker.file_unique_id) : null;
    if (cached) {
      logVerbose(`telegram: sticker cache hit for ${sticker.file_unique_id}`);
      const fileId = sticker.file_id ?? cached.fileId;
      const emoji = sticker.emoji ?? cached.emoji;
      const setName = sticker.set_name ?? cached.setName;
      if (fileId !== cached.fileId || emoji !== cached.emoji || setName !== cached.setName) {
        // Refresh cached sticker metadata on hits so sends/searches use latest file_id.
        cacheSticker({
          ...cached,
          fileId,
          emoji,
          setName,
        });
      }
      return {
        path: saved.path,
        contentType: saved.contentType,
        placeholder: "<media:sticker>",
        stickerMetadata: {
          emoji,
          setName,
          fileId,
          fileUniqueId: sticker.file_unique_id,
          cachedDescription: cached.description,
        },
      };
    }

    // Cache miss - return metadata for vision processing
    return {
      path: saved.path,
      contentType: saved.contentType,
      placeholder: "<media:sticker>",
      stickerMetadata: {
        emoji: sticker.emoji ?? undefined,
        setName: sticker.set_name ?? undefined,
        fileId: sticker.file_id,
        fileUniqueId: sticker.file_unique_id,
      },
    };
  } catch (err) {
    logVerbose(`telegram: failed to process sticker: ${String(err)}`);
    return null;
  }
}

export async function resolveMedia(
  ctx: TelegramContext,
  maxBytes: number,
  token: string,
  transport?: TelegramTransport,
): Promise<{
  path: string;
  contentType?: string;
  placeholder: string;
  stickerMetadata?: StickerMetadata;
  animationMetadata?: AnimationMetadata;
} | null> {
  const msg = ctx.message;
  const stickerResolved = await resolveStickerMedia({
    msg,
    ctx,
    maxBytes,
    token,
    transport,
  });
  if (stickerResolved !== undefined) {
    return stickerResolved;
  }

  // Handle animations (GIFs) separately to extract metadata
  if (msg.animation) {
    const anim = msg.animation;
    if (!anim.file_id) {
      return null;
    }

    try {
      const file = await resolveTelegramFileWithRetry(ctx);
      if (!file?.file_path) {
        logVerbose("telegram: getFile returned no file_path for animation");
        return null;
      }
      const fetchImpl = proxyFetch ?? globalThis.fetch;
      if (!fetchImpl) {
        logVerbose("telegram: fetch not available for animation download");
        return null;
      }
      const saved = await downloadAndSaveTelegramFile({
        filePath: file.file_path,
        token,
        fetchImpl,
        maxBytes,
        telegramFileName: anim.file_name ?? undefined,
      });

      return {
        path: saved.path,
        contentType: saved.contentType,
        placeholder: "<media:gif>",
        animationMetadata: {
          fileName: anim.file_name ?? undefined,
          fileId: anim.file_id,
          fileUniqueId: anim.file_unique_id,
          mimeType: anim.mime_type ?? undefined,
          duration: anim.duration ?? undefined,
        },
      };
    } catch (err) {
      logVerbose(`telegram: failed to process animation: ${String(err)}`);
      return null;
    }
  }

  const m = resolveMediaFileRef(msg);
  if (!m?.file_id) {
    return null;
  }

  const file = await resolveTelegramFileWithRetry(ctx);
  if (!file) {
    return null;
  }
  if (!file.file_path) {
    throw new Error("Telegram getFile returned no file_path");
  }
  const saved = await downloadAndSaveTelegramFile({
    filePath: file.file_path,
    token,
    transport: resolveRequiredTelegramTransport(transport),
    maxBytes,
    telegramFileName: resolveTelegramFileName(msg),
  });
  const placeholder = resolveTelegramMediaPlaceholder(msg) ?? "<media:document>";
  return { path: saved.path, contentType: saved.contentType, placeholder };
}
