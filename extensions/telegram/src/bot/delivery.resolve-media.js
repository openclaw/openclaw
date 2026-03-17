import { GrammyError } from "grammy";
import { logVerbose, warn } from "../../../../src/globals.js";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import { retryAsync } from "../../../../src/infra/retry.js";
import { fetchRemoteMedia } from "../../../../src/media/fetch.js";
import { saveMediaBuffer } from "../../../../src/media/store.js";
import { shouldRetryTelegramIpv4Fallback } from "../fetch.js";
import { cacheSticker, getCachedSticker } from "../sticker-cache.js";
import { resolveTelegramMediaPlaceholder } from "./helpers.js";
const FILE_TOO_BIG_RE = /file is too big/i;
const TELEGRAM_MEDIA_SSRF_POLICY = {
  // Telegram file downloads should trust api.telegram.org even when DNS/proxy
  // resolution maps to private/internal ranges in restricted networks.
  allowedHostnames: ["api.telegram.org"],
  allowRfc2544BenchmarkRange: true
};
function isFileTooBigError(err) {
  if (err instanceof GrammyError) {
    return FILE_TOO_BIG_RE.test(err.description);
  }
  return FILE_TOO_BIG_RE.test(formatErrorMessage(err));
}
function isRetryableGetFileError(err) {
  if (isFileTooBigError(err)) {
    return false;
  }
  return true;
}
function resolveMediaFileRef(msg) {
  return msg.photo?.[msg.photo.length - 1] ?? msg.video ?? msg.video_note ?? msg.document ?? msg.audio ?? msg.voice;
}
function resolveTelegramFileName(msg) {
  return msg.document?.file_name ?? msg.audio?.file_name ?? msg.video?.file_name ?? msg.animation?.file_name;
}
async function resolveTelegramFileWithRetry(ctx) {
  try {
    return await retryAsync(() => ctx.getFile(), {
      attempts: 3,
      minDelayMs: 1e3,
      maxDelayMs: 4e3,
      jitter: 0.2,
      label: "telegram:getFile",
      shouldRetry: isRetryableGetFileError,
      onRetry: ({ attempt, maxAttempts }) => logVerbose(`telegram: getFile retry ${attempt}/${maxAttempts}`)
    });
  } catch (err) {
    if (isFileTooBigError(err)) {
      logVerbose(
        warn(
          "telegram: getFile failed - file exceeds Telegram Bot API 20MB limit; skipping attachment"
        )
      );
      return null;
    }
    logVerbose(`telegram: getFile failed after retries: ${String(err)}`);
    return null;
  }
}
function resolveRequiredTelegramTransport(transport) {
  if (transport) {
    return transport;
  }
  const resolvedFetch = globalThis.fetch;
  if (!resolvedFetch) {
    throw new Error("fetch is not available; set channels.telegram.proxy in config");
  }
  return {
    fetch: resolvedFetch,
    sourceFetch: resolvedFetch
  };
}
function resolveOptionalTelegramTransport(transport) {
  try {
    return resolveRequiredTelegramTransport(transport);
  } catch {
    return null;
  }
}
const TELEGRAM_DOWNLOAD_IDLE_TIMEOUT_MS = 3e4;
async function downloadAndSaveTelegramFile(params) {
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
    ssrfPolicy: TELEGRAM_MEDIA_SSRF_POLICY
  });
  const originalName = params.telegramFileName ?? fetched.fileName ?? params.filePath;
  return saveMediaBuffer(
    fetched.buffer,
    fetched.contentType,
    "inbound",
    params.maxBytes,
    originalName
  );
}
async function resolveStickerMedia(params) {
  const { msg, ctx, maxBytes, token, transport } = params;
  if (!msg.sticker) {
    return void 0;
  }
  const sticker = msg.sticker;
  if (sticker.is_animated || sticker.is_video) {
    logVerbose("telegram: skipping animated/video sticker (only static stickers supported)");
    return null;
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
      maxBytes
    });
    const cached = sticker.file_unique_id ? getCachedSticker(sticker.file_unique_id) : null;
    if (cached) {
      logVerbose(`telegram: sticker cache hit for ${sticker.file_unique_id}`);
      const fileId = sticker.file_id ?? cached.fileId;
      const emoji = sticker.emoji ?? cached.emoji;
      const setName = sticker.set_name ?? cached.setName;
      if (fileId !== cached.fileId || emoji !== cached.emoji || setName !== cached.setName) {
        cacheSticker({
          ...cached,
          fileId,
          emoji,
          setName
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
          cachedDescription: cached.description
        }
      };
    }
    return {
      path: saved.path,
      contentType: saved.contentType,
      placeholder: "<media:sticker>",
      stickerMetadata: {
        emoji: sticker.emoji ?? void 0,
        setName: sticker.set_name ?? void 0,
        fileId: sticker.file_id,
        fileUniqueId: sticker.file_unique_id
      }
    };
  } catch (err) {
    logVerbose(`telegram: failed to process sticker: ${String(err)}`);
    return null;
  }
}
async function resolveMedia(ctx, maxBytes, token, transport) {
  const msg = ctx.message;
  const stickerResolved = await resolveStickerMedia({
    msg,
    ctx,
    maxBytes,
    token,
    transport
  });
  if (stickerResolved !== void 0) {
    return stickerResolved;
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
    telegramFileName: resolveTelegramFileName(msg)
  });
  const placeholder = resolveTelegramMediaPlaceholder(msg) ?? "<media:document>";
  return { path: saved.path, contentType: saved.contentType, placeholder };
}
export {
  resolveMedia
};
