import { StickerFormatType, type APIAttachment, type APIStickerItem } from "discord-api-types/v10";
import {
  formatMediaPlaceholderText,
  type ChannelInboundMediaInput,
} from "openclaw/plugin-sdk/channel-inbound";
import { getFileExtension, normalizeMimeType } from "openclaw/plugin-sdk/media-mime";
import { saveRemoteMedia, type FetchLike } from "openclaw/plugin-sdk/media-runtime";
import { getChildLogger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  getDiscordEndpointRuntime,
  resolveDiscordEndpointMediaGuard,
  type DiscordEndpointRuntime,
} from "../endpoint-runtime.js";
import type { Message } from "../internal/discord.js";
import { resolveDiscordCdnPolicy } from "./media-ssrf-policy.js";
import {
  resolveDiscordMessageSnapshots,
  resolveDiscordMessageStickers,
  resolveDiscordReferencedForwardMessage,
  resolveDiscordReferencedReplyMessage,
  resolveDiscordSnapshotStickers,
} from "./message-forwarded.js";
import { withAbortTimeout } from "./timeouts.js";

const AUDIO_ATTACHMENT_EXTENSIONS = new Set([
  ".aac",
  ".caf",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
]);

const DISCORD_STICKER_ASSET_BASE_URL = "https://media.discordapp.net/stickers";

export type DiscordMediaInfo = Pick<
  ChannelInboundMediaInput,
  "contentType" | "fileName" | "kind" | "path"
>;

type DiscordMediaResolveOptions = {
  fetchImpl?: FetchLike;
  ssrfPolicy?: SsrFPolicy;
  readIdleTimeoutMs?: number;
  totalTimeoutMs?: number;
  abortSignal?: AbortSignal;
};

type DiscordMediaOperation = DiscordMediaResolveOptions & {
  endpointRuntime: DiscordEndpointRuntime | null;
  maxBytes: number;
  out: DiscordMediaInfo[];
};

function createDiscordMediaOperation(
  maxBytes: number,
  options?: DiscordMediaResolveOptions,
): DiscordMediaOperation {
  return {
    ...options,
    ssrfPolicy: resolveDiscordCdnPolicy(options?.ssrfPolicy),
    endpointRuntime: getDiscordEndpointRuntime() ?? null,
    maxBytes,
    out: [],
  };
}

type DiscordStickerAssetCandidate = {
  url: string;
  fileName: string;
};

const NON_DEFINITIVE_MEDIA_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  // Discord can report this container type without identifying whether it holds audio or video.
  "application/ogg",
]);

function isDefinitiveMediaType(contentType: string | null | undefined): boolean {
  const normalized = normalizeMimeType(contentType);
  return Boolean(normalized && !NON_DEFINITIVE_MEDIA_TYPES.has(normalized));
}

function resolveDiscordMediaClassification(params: {
  attachment: APIAttachment;
  fetchedContentType?: string | null;
}): Pick<DiscordMediaInfo, "contentType" | "kind"> {
  const contentTypes = [params.fetchedContentType, params.attachment.content_type];
  const contentType =
    contentTypes.find(isDefinitiveMediaType) ??
    params.fetchedContentType ??
    params.attachment.content_type ??
    undefined;
  const mime = normalizeMimeType(contentType);
  const definitive = isDefinitiveMediaType(contentType);
  // Discord now sends duration_secs on ordinary video/image attachments, so a
  // bare duration is no longer a voice-note signal. A waveform remains the
  // definitive native voice-note marker and keeps overriding a conflicting
  // MIME; a duration-only hint only implies audio when the type is not a
  // definitive visual one.
  const definitiveVisual =
    mime?.startsWith("video/") === true || mime?.startsWith("image/") === true;
  const audioKind =
    mime?.startsWith("audio/") ||
    typeof params.attachment.waveform === "string" ||
    (!definitiveVisual &&
      (typeof params.attachment.duration_secs === "number" ||
        (AUDIO_ATTACHMENT_EXTENSIONS.has(
          getFileExtension(params.attachment.filename ?? params.attachment.url) ?? "",
        ) &&
          !definitive)))
      ? "audio"
      : undefined;
  const kind =
    audioKind ??
    (!definitive ? (isImageAttachment(params.attachment) ? "image" : "document") : undefined);

  return {
    // Inbound projection prefers MIME over kind. A native voice classification
    // or filename fallback must replace a non-definitive MIME rather than be masked by it.
    contentType:
      (audioKind && !mime?.startsWith("audio/")) || (kind && !definitive) ? undefined : contentType,
    ...(kind ? { kind } : {}),
  };
}

async function resolveMessageMedia(
  message: Message,
  operation: DiscordMediaOperation,
  errorPrefix: string,
): Promise<DiscordMediaInfo[]> {
  await appendResolvedMediaFromAttachments({
    ...operation,
    attachments: message.attachments ?? [],
    errorPrefix: `${errorPrefix} attachment`,
  });
  await appendResolvedMediaFromStickers({
    ...operation,
    stickers: resolveDiscordMessageStickers(message),
    errorPrefix: `${errorPrefix} sticker`,
  });
  return operation.out;
}

export async function resolveMediaList(
  message: Message,
  maxBytes: number,
  options?: DiscordMediaResolveOptions,
): Promise<DiscordMediaInfo[]> {
  return resolveMessageMedia(
    message,
    createDiscordMediaOperation(maxBytes, options),
    "discord: failed to download",
  );
}

export async function resolveForwardedMediaList(
  message: Message,
  maxBytes: number,
  options?: DiscordMediaResolveOptions,
): Promise<DiscordMediaInfo[]> {
  const snapshots = resolveDiscordMessageSnapshots(message);
  const operation = createDiscordMediaOperation(maxBytes, options);
  if (snapshots.length > 0) {
    for (const snapshot of snapshots) {
      await appendResolvedMediaFromAttachments({
        ...operation,
        attachments: snapshot.message?.attachments,
        errorPrefix: "discord: failed to download forwarded attachment",
      });
      await appendResolvedMediaFromStickers({
        ...operation,
        stickers: snapshot.message ? resolveDiscordSnapshotStickers(snapshot.message) : [],
        errorPrefix: "discord: failed to download forwarded sticker",
      });
    }
    return operation.out;
  }
  const referencedForward = resolveDiscordReferencedForwardMessage(message);
  return referencedForward
    ? resolveMessageMedia(referencedForward, operation, "discord: failed to download forwarded")
    : operation.out;
}

export async function resolveReferencedReplyMediaList(
  message: Message,
  maxBytes: number,
  options?: DiscordMediaResolveOptions,
): Promise<DiscordMediaInfo[]> {
  const referencedReply = resolveDiscordReferencedReplyMessage(message);
  return referencedReply
    ? resolveMessageMedia(
        referencedReply,
        createDiscordMediaOperation(maxBytes, options),
        "discord: failed to download referenced reply",
      )
    : [];
}

async function fetchDiscordMedia(
  operation: Omit<DiscordMediaOperation, "out">,
  params: {
    url: string;
    filePathHint: string;
    fallbackContentType?: string;
    originalFilename?: string;
  },
) {
  const endpointGuard = resolveDiscordEndpointMediaGuard(params.url, operation.endpointRuntime);
  const save = (signal?: AbortSignal) =>
    saveRemoteMedia({
      ...params,
      maxBytes: operation.maxBytes,
      // Endpoint media owns its pinned transport; an account proxy must not replace it.
      fetchImpl: endpointGuard ? undefined : operation.fetchImpl,
      ssrfPolicy: endpointGuard?.ssrfPolicy ?? operation.ssrfPolicy,
      ...(endpointGuard ? { maxRedirects: endpointGuard.maxRedirects } : {}),
      readIdleTimeoutMs: operation.readIdleTimeoutMs,
      ...(signal ? { requestInit: { signal } } : {}),
    });
  return operation.totalTimeoutMs
    ? withAbortTimeout({
        timeoutMs: operation.totalTimeoutMs,
        createTimeoutError: () =>
          new Error(`discord media download timed out after ${operation.totalTimeoutMs}ms`),
        run: (signal) =>
          save(operation.abortSignal ? AbortSignal.any([operation.abortSignal, signal]) : signal),
      })
    : save(operation.abortSignal);
}

async function appendResolvedMediaFromAttachments(
  params: DiscordMediaOperation & {
    attachments?: APIAttachment[] | null;
    errorPrefix: string;
  },
) {
  for (const attachment of params.attachments ?? []) {
    const attachmentUrl = normalizeOptionalString(attachment.url);
    if (!attachmentUrl) {
      logVerbose(
        `${params.errorPrefix} ${attachment.id ?? attachment.filename ?? "attachment"}: missing url`,
      );
      params.out.push(resolveDiscordMediaClassification({ attachment }));
      continue;
    }
    try {
      const saved = await fetchDiscordMedia(params, {
        url: attachmentUrl,
        filePathHint: attachment.filename ?? attachmentUrl,
        fallbackContentType: attachment.content_type,
        originalFilename: attachment.filename,
      });
      const classification = resolveDiscordMediaClassification({
        attachment,
        fetchedContentType: saved.contentType,
      });
      params.out.push({
        path: saved.path,
        fileName: attachment.filename,
        ...classification,
      });
    } catch (err) {
      const id = attachment.id ?? attachmentUrl;
      // Warn on the default path: the failed download becomes a path-less fact
      // that core drops from the media projection, so this log plus the body
      // notice are the only records of the missing attachment.
      getChildLogger({ module: "discord-media" }).warn(
        `${params.errorPrefix} ${id}: ${String(err)}`,
      );
      params.out.push(resolveDiscordMediaClassification({ attachment }));
    }
  }
}

function resolveStickerAssetCandidates(sticker: APIStickerItem): DiscordStickerAssetCandidate[] {
  const baseName = sticker.name?.trim() || `sticker-${sticker.id}`;
  const isLottie = sticker.format_type === StickerFormatType.Lottie;
  const extensions = isLottie
    ? ["png", "json"]
    : [sticker.format_type === StickerFormatType.GIF ? "gif" : "png"];
  return extensions.map((extension) => ({
    url: `${DISCORD_STICKER_ASSET_BASE_URL}/${sticker.id}.${extension}${isLottie && extension === "png" ? "?size=160" : ""}`,
    fileName: `${baseName}.${extension}`,
  }));
}

function formatStickerError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  try {
    return JSON.stringify(err) ?? "unknown error";
  } catch {
    return "unknown error";
  }
}

function inferStickerContentType(sticker: APIStickerItem): string | undefined {
  switch (sticker.format_type) {
    case StickerFormatType.GIF:
      return "image/gif";
    case StickerFormatType.APNG:
    case StickerFormatType.Lottie:
    case StickerFormatType.PNG:
      return "image/png";
    default:
      return undefined;
  }
}

async function appendResolvedMediaFromStickers(
  params: DiscordMediaOperation & {
    stickers?: APIStickerItem[] | null;
    errorPrefix: string;
  },
) {
  for (const sticker of params.stickers ?? []) {
    const candidates = resolveStickerAssetCandidates(sticker);
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        const saved = await fetchDiscordMedia(params, {
          url: candidate.url,
          filePathHint: candidate.fileName,
          fallbackContentType: inferStickerContentType(sticker),
          originalFilename: candidate.fileName,
        });
        params.out.push({
          path: saved.path,
          contentType: saved.contentType,
          fileName: candidate.fileName,
          kind: "sticker",
        });
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) {
      // Same visibility contract as failed attachments: path-less fact + warn.
      getChildLogger({ module: "discord-media" }).warn(
        `${params.errorPrefix} ${sticker.id}: ${formatStickerError(lastError)}`,
      );
      params.out.push({
        contentType: inferStickerContentType(sticker),
        kind: "sticker",
      });
    }
  }
}

function isImageAttachment(attachment: APIAttachment): boolean {
  const mime = attachment.content_type ?? "";
  if (mime.startsWith("image/")) {
    return true;
  }
  const name = normalizeLowercaseStringOrEmpty(attachment.filename);
  if (!name) {
    return false;
  }
  return /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/.test(name);
}

/** Renders native Discord media only for transcript surfaces that cannot carry facts. */
export function formatDiscordMediaText(params: {
  attachments?: APIAttachment[];
  stickers?: APIStickerItem[];
}): string {
  return formatMediaPlaceholderText([
    ...(params.attachments ?? []).map((attachment) =>
      resolveDiscordMediaClassification({ attachment }),
    ),
    ...(params.stickers ?? []).map(() => ({ kind: "sticker" as const })),
  ]);
}
