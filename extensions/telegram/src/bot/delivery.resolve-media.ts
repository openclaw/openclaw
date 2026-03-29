import path from "node:path";
import { GrammyError } from "grammy";
import { fetchRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
import { logVerbose, warn } from "openclaw/plugin-sdk/runtime-env";
import { retryAsync } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  resolveTelegramApiBase,
  shouldRetryTelegramTransportFallback,
  type TelegramTransport,
} from "../fetch.js";
import { cacheSticker, getCachedSticker } from "../sticker-cache.js";
import { resolveTelegramMediaPlaceholder } from "./helpers.js";
import type { StickerMetadata, TelegramContext } from "./types.js";

const FILE_TOO_BIG_RE = /file is too big/i;
const GrammyErrorCtor: typeof GrammyError | undefined =
  typeof GrammyError === "function" ? GrammyError : undefined;

function buildTelegramMediaSsrfPolicy(apiRoot?: string) {
  const hostnames = ["api.telegram.org"];
  let allowedHostnames: string[] | undefined;
  if (apiRoot) {
    try {
      const customHost = new URL(apiRoot).hostname;
      if (customHost && !hostnames.includes(customHost)) {
        hostnames.push(customHost);
        // A configured custom Bot API host is an explicit operator override and
        // may legitimately live on a private network (for example, self-hosted
        // Bot API or an internal reverse proxy). Keep that host reachable while
        // still enforcing resolved-IP checks for the default public host.
        allowedHostnames = [customHost];
      }
    } catch {
      // invalid URL; fall through to default
    }
  }
  return {
    // Restrict media downloads to the configured Telegram API hosts while still
    // enforcing SSRF checks on the resolved and redirected targets.
    hostnameAllowlist: hostnames,
    // Always allow the Telegram API hostnames through private-IP checks so media
    // downloads work in fake-IP proxy environments (Clash/Mihomo/Surge) where
    // api.telegram.org resolves to a virtual private address.
    allowedHostnames: hostnames,
    allowRfc2544BenchmarkRange: false,
  };
}

/**
 * Returns true if the error is Telegram's "file is too big" error.
 * This happens when trying to download files >20MB via the Bot API.
 * Unlike network errors, this is a permanent error and should not be retried.
 */
function isFileTooBigError(err: unknown): boolean {
  if (GrammyErrorCtor && err instanceof GrammyErrorCtor) {
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
  apiRoot?: string;
}) {
  if (path.isAbsolute(params.filePath)) {
    return { path: params.filePath, contentType: undefined };
  }
  const apiBase = resolveTelegramApiBase(params.apiRoot);
  const url = `${apiBase}/file/bot${params.token}/${params.filePath}`;
  const fetched = await fetchRemoteMedia({
    url,
    fetchImpl: params.transport.sourceFetch,
    dispatcherAttempts: params.transport.dispatcherAttempts,
    shouldRetryFetchError: shouldRetryTelegramTransportFallback,
    filePathHint: params.filePath,
    maxBytes: params.maxBytes,
    readIdleTimeoutMs: TELEGRAM_DOWNLOAD_IDLE_TIMEOUT_MS,
    ssrfPolicy: buildTelegramMediaSsrfPolicy(params.apiRoot),
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
  apiRoot?: string;
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
  // Skip animated (TGS) and video (WEBM) stickers - only static WEBP supported
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
      maxBytes,
      apiRoot: params.apiRoot,
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
  apiRoot?: string,
): Promise<{
  path: string;
  contentType?: string;
  placeholder: string;
  stickerMetadata?: StickerMetadata;
} | null> {
  const msg = ctx.message;
  const stickerResolved = await resolveStickerMedia({
    msg,
    ctx,
    maxBytes,
    token,
    transport,
    apiRoot,
  });
  if (stickerResolved !== undefined) {
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
    telegramFileName: resolveTelegramFileName(msg),
    apiRoot,
  });
  const placeholder = resolveTelegramMediaPlaceholder(msg) ?? "<media:document>";
  return { path: saved.path, contentType: saved.contentType, placeholder };
}
