import path from "node:path";
import type * as Lark from "@larksuiteoapi/node-sdk";
import { detectMime, mediaKindFromMime } from "openclaw/plugin-sdk/media-mime";
import {
  buildOutboundMediaLoadOptions,
  MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS,
  runFfmpeg,
  runFfprobe,
  type OutboundMediaAccess,
} from "openclaw/plugin-sdk/media-runtime";
import type { SavedMedia } from "openclaw/plugin-sdk/media-store";
import type { ReplyPayloadTtsSupplement } from "openclaw/plugin-sdk/reply-payload";
import { writeExternalFileWithinRoot } from "openclaw/plugin-sdk/security-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { requestFeishuApi } from "./comment-shared.js";
import { normalizeFeishuExternalKey } from "./external-keys.js";
import { saveMediaStreamWithIdleTimeout } from "./media-chunk-idle.js";
import { getFeishuRuntime } from "./runtime.js";
import { runBeforeFeishuMessageDispatch } from "./send-context.js";
import { resolveFeishuSendTarget } from "./send-target.js";
import { sendReplyOrFallbackDirect } from "./send.js";
import type { FeishuSendResult } from "./types.js";

const FEISHU_MEDIA_HTTP_TIMEOUT_MS = 120_000;
const FEISHU_MAX_FILE_UPLOAD_BYTES = 30 * 1024 * 1024;
const FEISHU_MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;
const FEISHU_VOICE_FILE_NAME = "voice.ogg";
const FEISHU_VOICE_SAMPLE_RATE_HZ = 48_000;
const FEISHU_VOICE_BITRATE = "64k";

const FEISHU_SUPPORTED_IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/x-ms-bmp",
  "image/tiff",
  "image/tif",
  // The platform accepts HEIC even though older generated SDK comments omit it.
  "image/heic",
  "image/x-icon",
  "image/ico",
  "image/vnd.microsoft.icon",
]);

const FEISHU_TRANSCODABLE_AUDIO_EXTS = new Set([
  ".aac",
  ".aiff",
  ".alac",
  ".amr",
  ".caf",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".wav",
  ".webm",
  ".wma",
]);

type SaveMessageResourceResult = {
  saved: SavedMedia;
  contentType?: string;
  fileName?: string;
};

function createConfiguredFeishuMediaClient(params: { cfg: ClawdbotConfig; accountId?: string }) {
  const account = resolveFeishuRuntimeAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  return createFeishuClient({ ...account, httpTimeoutMs: FEISHU_MEDIA_HTTP_TIMEOUT_MS });
}

type FeishuUploadResponse =
  | Awaited<ReturnType<Lark.Client["im"]["image"]["create"]>>
  | Awaited<ReturnType<Lark.Client["im"]["file"]["create"]>>;

type FeishuHeaderMap = Record<string, string | string[]>;
type FeishuMessageResourceDownloadType = "image" | "file" | "media";

function asHeaderMap(value: object | undefined): FeishuHeaderMap | undefined {
  if (!value) {
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.every(([, entry]) => typeof entry === "string" || Array.isArray(entry))) {
    return Object.fromEntries(entries) as FeishuHeaderMap;
  }
  return undefined;
}

function extractFeishuUploadKey(
  response: FeishuUploadResponse,
  params: {
    key: "image_key" | "file_key";
    errorPrefix: string;
  },
): string {
  if (!response) {
    throw new Error(`${params.errorPrefix}: empty response`);
  }

  const wrappedResponse = response as {
    image_key?: string;
    file_key?: string;
    code?: number;
    msg?: string;
    data?: Partial<Record<"image_key" | "file_key", string>>;
  };
  if (wrappedResponse.code !== undefined && wrappedResponse.code !== 0) {
    throw new Error(
      `${params.errorPrefix}: ${wrappedResponse.msg || `code ${wrappedResponse.code}`}`,
    );
  }

  const key = wrappedResponse[params.key] ?? wrappedResponse.data?.[params.key];
  if (!key) {
    throw new Error(`${params.errorPrefix}: no ${params.key} returned`);
  }
  return key;
}

function readHeaderValue(
  headers: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (normalizeLowercaseStringOrEmpty(key) !== normalizeLowercaseStringOrEmpty(name)) {
      continue;
    }
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (Array.isArray(value)) {
      const first = value.find((entry) => typeof entry === "string" && entry.trim());
      if (typeof first === "string") {
        return first.trim();
      }
    }
  }
  return undefined;
}

function readHttpStatusFromError(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const response = (error as { response?: unknown }).response;
  if (response && typeof response === "object") {
    const status = (response as { status?: unknown }).status;
    if (typeof status === "number") {
      return status;
    }
  }

  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function containsEastAsianScript(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);
}

function recoverUtf8FileNameFromLatin1Header(value: string): string {
  const recovered = Buffer.from(value, "latin1").toString("utf8");
  if (recovered !== value && !recovered.includes("\uFFFD") && containsEastAsianScript(recovered)) {
    return recovered;
  }
  return value;
}

function decodeDispositionFileName(value: string): string | undefined {
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim().replace(/^"(.*)"$/, "$1"));
    } catch {
      return utf8Match[1].trim().replace(/^"(.*)"$/, "$1");
    }
  }

  const plainMatch = value.match(/filename="?([^";]+)"?/i);
  const plainFileName = plainMatch?.[1]?.trim();
  return plainFileName ? recoverUtf8FileNameFromLatin1Header(plainFileName) : undefined;
}

async function saveMessageResourceWithType(params: {
  client: ReturnType<typeof createFeishuClient>;
  messageId: string;
  fileKey: string;
  type: FeishuMessageResourceDownloadType;
  maxBytes: number;
  originalFilename?: string;
}): Promise<SaveMessageResourceResult> {
  const response = await params.client.im.messageResource.get({
    path: { message_id: params.messageId, file_key: params.fileKey },
    params: { type: params.type },
  });
  // The SDK owns response adaptation and always returns a readable stream plus headers.
  const headers = asHeaderMap(response.headers);
  const contentType = readHeaderValue(headers, "content-type");
  const disposition = readHeaderValue(headers, "content-disposition");
  const fileName = disposition ? decodeDispositionFileName(disposition) : undefined;
  const saved = await saveMediaStreamWithIdleTimeout(
    response.getReadableStream(),
    contentType,
    params.maxBytes,
    fileName ??
      (params.originalFilename
        ? recoverUtf8FileNameFromLatin1Header(params.originalFilename)
        : undefined),
    FEISHU_MEDIA_HTTP_TIMEOUT_MS,
  );
  return { saved, contentType, fileName };
}

export async function saveMessageResourceFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  fileKey: string;
  type: "image" | "file";
  accountId?: string;
  maxBytes: number;
  originalFilename?: string;
}): Promise<SaveMessageResourceResult> {
  const { cfg, messageId, fileKey, type, accountId, maxBytes, originalFilename } = params;
  const normalizedFileKey = normalizeFeishuExternalKey(fileKey);
  if (!normalizedFileKey) {
    throw new Error("Feishu message resource download failed: invalid file_key");
  }
  const client = createConfiguredFeishuMediaClient({ cfg, accountId });
  const request = {
    client,
    messageId,
    fileKey: normalizedFileKey,
    type,
    maxBytes,
    originalFilename,
  };

  try {
    return await saveMessageResourceWithType(request);
  } catch (err) {
    if (type !== "file" || readHttpStatusFromError(err) !== 502) {
      throw err;
    }
    try {
      return await saveMessageResourceWithType({ ...request, type: "media" });
    } catch {
      throw err;
    }
  }
}

export type SendMediaResult = FeishuSendResult & {
  voiceIntentDegradedToFile?: boolean;
};

/**
 * Sanitize a filename for safe use in Feishu multipart/form-data uploads.
 * Strips control characters and multipart-injection vectors (CWE-93) while
 * preserving the original UTF-8 display name (Chinese, emoji, etc.).
 *
 * Previous versions percent-encoded non-ASCII characters, but the Feishu
 * `im.file.create` API uses `file_name` as a literal display name — it does
 * NOT decode percent-encoding — so encoded filenames appeared as garbled text
 * in chat (regression in v2026.3.2).
 */
function sanitizeFileNameForUpload(fileName: string): string {
  return fileName.replace(/[\p{Cc}"\\]/gu, "_");
}

type SendUploadedMediaParams = {
  cfg: ClawdbotConfig;
  to: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  allowTopLevelReplyFallback?: boolean;
  accountId?: string;
};

async function sendUploadedMediaFeishu(
  params: SendUploadedMediaParams,
  media: { image_key: string } | { file_key: string },
  msgType: "image" | "file" | "audio" | "media" | "sticker",
): Promise<SendMediaResult> {
  const target = resolveFeishuSendTarget(params);
  const label = msgType === "image" ? "image" : "file";
  return sendReplyOrFallbackDirect(target, {
    ...params,
    content: JSON.stringify(media),
    msgType,
    directErrorPrefix: `Feishu ${label} send failed`,
    replyErrorPrefix: `Feishu ${label} reply failed`,
  });
}

// Feishu only permits reusing sticker file_keys already received by this bot.
export function sendStickerFeishu(
  params: SendUploadedMediaParams & { fileKey: string },
): Promise<SendMediaResult> {
  return sendUploadedMediaFeishu(params, { file_key: params.fileKey }, "sticker");
}

function detectFileType(fileName: string): "pdf" | "doc" | "xls" | "ppt" | "stream" {
  const ext = normalizeLowercaseStringOrEmpty(path.extname(fileName));
  switch (ext) {
    case ".pdf":
      return "pdf";
    case ".doc":
    case ".docx":
      return "doc";
    case ".xls":
    case ".xlsx":
      return "xls";
    case ".ppt":
    case ".pptx":
      return "ppt";
    default:
      return "stream";
  }
}

type FeishuMedia = {
  buffer: Buffer;
  fileName: string;
  contentType?: string;
};

async function resolveFeishuOutboundMediaKind(params: FeishuMedia): Promise<{
  fileType?: "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream";
  msgType: "image" | "file" | "audio" | "media";
}> {
  const { buffer, fileName, contentType } = params;
  const ext = normalizeLowercaseStringOrEmpty(path.extname(fileName));
  // Never pass a filename to signature detection: an image-looking name must not
  // disguise SVG, AVIF, documents, or unrecognized bytes as native Feishu images.
  const detectedContentType = (await detectMime({ buffer })) ?? "";
  if (FEISHU_SUPPORTED_IMAGE_CONTENT_TYPES.has(detectedContentType)) {
    return { msgType: "image" };
  }

  if (
    ext === ".opus" ||
    ext === ".ogg" ||
    contentType === "audio/ogg" ||
    contentType === "audio/opus"
  ) {
    return { fileType: "opus", msgType: "audio" };
  }

  if (
    [".mp4", ".mov", ".avi"].includes(ext) ||
    contentType === "video/mp4" ||
    contentType === "video/quicktime" ||
    contentType === "video/x-msvideo"
  ) {
    return { fileType: "mp4", msgType: "media" };
  }

  return { fileType: detectFileType(fileName), msgType: "file" };
}

function assertFeishuUploadWithinEnvelope(params: {
  buffer: Buffer;
  mediaMaxBytes: number;
  msgType: "image" | "file" | "audio" | "media";
}): void {
  if (params.buffer.byteLength === 0) {
    throw new Error("Feishu attachments cannot be empty");
  }
  const maxBytes =
    params.msgType === "image"
      ? Math.min(params.mediaMaxBytes, FEISHU_MAX_IMAGE_UPLOAD_BYTES)
      : params.mediaMaxBytes;
  if (params.buffer.byteLength > maxBytes) {
    const label = params.msgType === "image" ? "image" : "file";
    throw new Error(`Feishu ${label} exceeds its ${String(maxBytes)}-byte upload limit`);
  }
}

function isFeishuNativeVoiceAudio(params: { fileName: string; contentType?: string }): boolean {
  const ext = normalizeLowercaseStringOrEmpty(path.extname(params.fileName));
  const contentType = normalizeLowercaseStringOrEmpty(params.contentType);
  return (
    ext === ".opus" || ext === ".ogg" || contentType === "audio/ogg" || contentType === "audio/opus"
  );
}

function normalizeMediaNameForExtension(raw: string): string {
  try {
    return new URL(raw).pathname;
  } catch {
    return raw.split(/[?#]/, 1)[0] ?? raw;
  }
}

export function shouldSuppressFeishuTextForVoiceMedia(params: {
  mediaUrl?: string;
  fileName?: string;
  contentType?: string;
  audioAsVoice?: boolean;
  ttsSupplement?: ReplyPayloadTtsSupplement;
}): boolean {
  // TTS metadata owns visibility; voice-bubble inference must not hide text
  // that has not been delivered yet.
  if (params.ttsSupplement) {
    return params.ttsSupplement.visibleTextAlreadyDelivered === true;
  }

  if (params.audioAsVoice === true) {
    return true;
  }

  if (
    params.fileName &&
    isFeishuNativeVoiceAudio({
      fileName: params.fileName,
      contentType: params.contentType,
    })
  ) {
    return true;
  }
  if (!params.mediaUrl) {
    return false;
  }
  return isFeishuNativeVoiceAudio({
    fileName: normalizeMediaNameForExtension(params.mediaUrl),
    contentType: params.contentType,
  });
}

function isLikelyTranscodableAudio(params: { fileName: string; contentType?: string }): boolean {
  const ext = normalizeLowercaseStringOrEmpty(path.extname(params.fileName));
  const contentType = normalizeLowercaseStringOrEmpty(params.contentType);
  return FEISHU_TRANSCODABLE_AUDIO_EXTS.has(ext) || mediaKindFromMime(contentType) === "audio";
}

async function transcodeToFeishuVoiceOpus(
  params: FeishuMedia,
): Promise<FeishuMedia & { contentType: string }> {
  return await withTempWorkspace(
    { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "feishu-voice-" },
    async (workspace) => {
      const ext = normalizeLowercaseStringOrEmpty(path.extname(params.fileName));
      const inputExt = ext && ext.length <= 12 ? ext : ".audio";
      const inputPath = await workspace.write(`input${inputExt}`, params.buffer);
      await writeExternalFileWithinRoot({
        rootDir: workspace.dir,
        path: FEISHU_VOICE_FILE_NAME,
        write: async (outputPath) => {
          await runFfmpeg([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            inputPath,
            "-vn",
            "-sn",
            "-dn",
            "-t",
            String(MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS),
            "-ar",
            String(FEISHU_VOICE_SAMPLE_RATE_HZ),
            "-ac",
            "1",
            "-c:a",
            "libopus",
            "-b:a",
            FEISHU_VOICE_BITRATE,
            "-f",
            "ogg",
            outputPath,
          ]);
        },
      });
      return {
        buffer: await workspace.read(FEISHU_VOICE_FILE_NAME),
        fileName: FEISHU_VOICE_FILE_NAME,
        contentType: "audio/ogg",
      };
    },
  );
}

async function prepareFeishuVoiceMedia(
  params: FeishuMedia & { audioAsVoice?: boolean },
): Promise<FeishuMedia> {
  if (isFeishuNativeVoiceAudio(params)) {
    return params;
  }
  if (params.audioAsVoice !== true || !isLikelyTranscodableAudio(params)) {
    return params;
  }
  try {
    return await transcodeToFeishuVoiceOpus(params);
  } catch (err) {
    console.warn(
      `[feishu] audioAsVoice transcode failed; sending ${params.fileName} as a file attachment:`,
      err,
    );
    return params;
  }
}

async function probeMediaDurationMs(params: FeishuMedia): Promise<number | undefined> {
  try {
    return await withTempWorkspace(
      { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "feishu-media-probe-" },
      async (workspace) => {
        const ext = normalizeLowercaseStringOrEmpty(path.extname(params.fileName));
        const inferredExt =
          ext && ext.length <= 12
            ? ext
            : mediaKindFromMime(params.contentType) === "video"
              ? ".mp4"
              : ".ogg";
        const inputPath = await workspace.write(`input${inferredExt}`, params.buffer);
        const stdout = await runFfprobe(
          ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", inputPath],
          { timeoutMs: 5_000 },
        );
        const seconds = Number.parseFloat(stdout.trim());
        if (!Number.isFinite(seconds) || seconds <= 0) {
          return undefined;
        }
        return Math.max(1, Math.round(seconds * 1000));
      },
    );
  } catch (err) {
    console.warn("[feishu] failed to probe media duration; upload will omit it:", err);
    return undefined;
  }
}

/**
 * Upload and send media (image or file) from URL, local path, or buffer.
 * Local paths require host-owned mediaAccess or approved legacy roots/readers.
 */
export async function sendMediaFeishu(
  params: SendUploadedMediaParams & {
    mediaUrl?: string;
    mediaBuffer?: Buffer;
    fileName?: string;
    mediaAccess?: OutboundMediaAccess;
    /** Allowed roots for local path reads; required for local filePath to work. */
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: OutboundMediaAccess["readFile"];
    /** When true, transcode compatible audio to Feishu native Ogg/Opus voice bubbles. */
    audioAsVoice?: boolean;
  },
): Promise<SendMediaResult> {
  const { cfg, mediaUrl, mediaBuffer, fileName, accountId, mediaLocalRoots, audioAsVoice } = params;
  const account = await runBeforeFeishuMessageDispatch(() => {
    const resolved = resolveFeishuRuntimeAccount({ cfg, accountId });
    if (!resolved.configured) {
      throw new Error(`Feishu account "${resolved.accountId}" not configured`);
    }
    return resolved;
  });
  const mediaMaxBytes = Math.min(
    (account.config?.mediaMaxMb ?? 30) * 1024 * 1024,
    FEISHU_MAX_FILE_UPLOAD_BYTES,
  );

  const loaded = await runBeforeFeishuMessageDispatch(async () => {
    if (mediaBuffer) {
      return { buffer: mediaBuffer, fileName: fileName ?? "file", contentType: undefined };
    }
    if (mediaUrl) {
      const media = await getFeishuRuntime().media.loadWebMedia(
        mediaUrl,
        buildOutboundMediaLoadOptions({
          maxBytes: mediaMaxBytes,
          mediaAccess: params.mediaAccess,
          mediaLocalRoots,
          mediaReadFile: params.mediaReadFile,
          optimizeImages: false,
        }),
      );
      return {
        buffer: media.buffer,
        fileName: fileName ?? media.fileName ?? "file",
        contentType: media.contentType,
      };
    }
    throw new Error("Either mediaUrl or mediaBuffer must be provided");
  });
  const loadedRouting = await runBeforeFeishuMessageDispatch(() =>
    resolveFeishuOutboundMediaKind(loaded),
  );
  await runBeforeFeishuMessageDispatch(() =>
    assertFeishuUploadWithinEnvelope({
      buffer: loaded.buffer,
      mediaMaxBytes,
      msgType: loadedRouting.msgType,
    }),
  );

  const prepared = await runBeforeFeishuMessageDispatch(() =>
    prepareFeishuVoiceMedia({ ...loaded, audioAsVoice }),
  );
  const { buffer, fileName: name, contentType } = prepared;

  const routing =
    prepared.buffer === loaded.buffer &&
    prepared.fileName === loaded.fileName &&
    prepared.contentType === loaded.contentType
      ? loadedRouting
      : await runBeforeFeishuMessageDispatch(() =>
          resolveFeishuOutboundMediaKind({ buffer, fileName: name, contentType }),
        );
  const voiceIntentDegradedToFile =
    routing.msgType !== "audio" &&
    shouldSuppressFeishuTextForVoiceMedia({ mediaUrl, audioAsVoice });

  await runBeforeFeishuMessageDispatch(() =>
    assertFeishuUploadWithinEnvelope({ buffer, mediaMaxBytes, msgType: routing.msgType }),
  );

  const durationMs =
    routing.msgType === "audio" || routing.msgType === "media"
      ? await probeMediaDurationMs({ buffer, fileName: name, contentType })
      : undefined;
  const media = await runBeforeFeishuMessageDispatch(async () => {
    const client = createConfiguredFeishuMediaClient({ cfg, accountId });
    const isImage = routing.msgType === "image";
    const errorPrefix = `Feishu ${isImage ? "image" : "file"} upload failed`;
    const response = await requestFeishuApi<FeishuUploadResponse>(
      () =>
        isImage
          ? client.im.image.create({ data: { image_type: "message", image: buffer } })
          : client.im.file.create({
              data: {
                file_type: routing.fileType ?? "stream",
                file_name: sanitizeFileNameForUpload(name),
                file: buffer,
                ...(durationMs !== undefined ? { duration: durationMs } : {}),
              },
            }),
      errorPrefix,
      { includeNestedErrorLogId: true },
    );
    const key = extractFeishuUploadKey(response, {
      key: isImage ? "image_key" : "file_key",
      errorPrefix,
    });
    return isImage ? { image_key: key } : { file_key: key };
  });
  const result = await sendUploadedMediaFeishu(params, media, routing.msgType);
  return {
    ...result,
    ...(voiceIntentDegradedToFile ? { voiceIntentDegradedToFile: true } : {}),
  };
}
