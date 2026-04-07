/**
 * WeCom outbound media upload utility module
 *
 * Responsible for:
 * - Loading file buffers from mediaUrl (supports both remote URLs and local paths)
 * - Detecting MIME types and mapping them to WeCom media types
 * - File size checking and downgrade strategies
 */

import type { WeComMediaType, WSClient, WsFrameHeaders } from "@wecom/aibot-node-sdk";
import {
  IMAGE_MAX_BYTES,
  VIDEO_MAX_BYTES,
  VOICE_MAX_BYTES,
  ABSOLUTE_MAX_BYTES,
} from "./const.js";
import { loadOutboundMediaFromUrl, detectMime, type WebMediaResult } from "./openclaw-compat.js";

// ============================================================================
// Type definitions
// ============================================================================

/** Resolved media file result */
export interface ResolvedMedia {
  /** File data */
  buffer: Buffer;
  /** Detected MIME type */
  contentType: string;
  /** Filename (extracted from URL or generated as default) */
  fileName: string;
}

/** File size check result */
export interface FileSizeCheckResult {
  /** Final WeCom media type (may have been downgraded) */
  finalType: WeComMediaType;
  /** Whether the file should be rejected (exceeds absolute limit) */
  shouldReject: boolean;
  /** Rejection reason (only present when shouldReject=true) */
  rejectReason?: string;
  /** Whether a downgrade occurred */
  downgraded: boolean;
  /** Downgrade explanation (only present when downgraded=true) */
  downgradeNote?: string;
}

// ============================================================================
// MIME → WeCom media type mapping
// ============================================================================

/**
 * Detect the WeCom media type from a MIME type
 *
 * @param mimeType - MIME type string
 * @returns WeCom media type
 */
export function detectWeComMediaType(mimeType: string): WeComMediaType {
  const mime = mimeType.toLowerCase();

  // Image types
  if (mime.startsWith("image/")) {
    return "image";
  }

  // Video types
  if (mime.startsWith("video/")) {
    return "video";
  }

  // Voice/audio types
  if (
    mime.startsWith("audio/") ||
    mime === "application/ogg" // OGG audio container
  ) {
    return "voice";
  }

  // Default to file for all other types
  return "file";
}

// ============================================================================
// Media file loading
// ============================================================================

/**
 * Load a media file from a mediaUrl
 *
 * Supports remote URLs (http/https) and local paths (file:// or absolute paths),
 * using the openclaw plugin-sdk's loadOutboundMediaFromUrl for unified handling.
 *
 * @param mediaUrl - URL or local path of the media file
 * @param mediaLocalRoots - Allowed local directory whitelist for reading local files
 * @returns Resolved media file information
 */
export async function resolveMediaFile(
  mediaUrl: string,
  mediaLocalRoots?: readonly string[],
): Promise<ResolvedMedia> {
  // Use the compatibility layer to load the media file (prefer SDK, fallback if unavailable)
  // Pass a large enough maxBytes; we do our own size check in a later step
  const result: WebMediaResult = await loadOutboundMediaFromUrl(mediaUrl, {
    maxBytes: ABSOLUTE_MAX_BYTES,
    mediaLocalRoots,
  });

  if (!result.buffer || result.buffer.length === 0) {
    throw new Error(`Failed to load media from ${mediaUrl}: empty buffer`);
  }

  // Detect the actual MIME type
  let contentType = result.contentType || "application/octet-stream";

  // If no accurate contentType was returned, try detecting via buffer magic bytes
  if (contentType === "application/octet-stream" || contentType === "text/plain") {
    const detected = await detectMime(result.buffer);
    if (detected) {
      contentType = detected;
    }
  }

  // 提取文件名
  const fileName = extractFileName(mediaUrl, result.fileName, contentType);

  return {
    buffer: result.buffer,
    contentType,
    fileName,
  };
}

// ============================================================================
// 文件大小检查与降级
// ============================================================================

/** 企微语音消息仅支持 AMR 格式 */
const VOICE_SUPPORTED_MIMES = new Set(["audio/amr"]);

/**
 * 检查文件大小并执行降级策略
 *
 * 降级规则：
 * - voice 非 AMR 格式 → 降级为 file（企微后台仅支持 AMR）
 * - image 超过 10MB → 降级为 file
 * - video 超过 10MB → 降级为 file
 * - voice 超过 2MB → 降级为 file
 * - file 超过 20MB → 拒绝发送
 *
 * @param fileSize - 文件大小（字节）
 * @param detectedType - 检测到的企微媒体类型
 * @param contentType - 文件的 MIME 类型（用于语音格式校验）
 * @returns 大小检查结果
 */
export function applyFileSizeLimits(
  fileSize: number,
  detectedType: WeComMediaType,
  contentType?: string,
): FileSizeCheckResult {
  const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);

  // First check the absolute limit (20MB)
  if (fileSize > ABSOLUTE_MAX_BYTES) {
    return {
      finalType: detectedType,
      shouldReject: true,
      rejectReason: `文件大小 ${fileSizeMB}MB 超过了企业微信允许的最大限制 20MB，无法发送。请尝试压缩文件或减小文件大小。`,
      downgraded: false,
    };
  }

  // 按类型检查大小限制
  switch (detectedType) {
    case "image":
      if (fileSize > IMAGE_MAX_BYTES) {
        return {
          finalType: "file",
          shouldReject: false,
          downgraded: true,
          downgradeNote: `图片大小 ${fileSizeMB}MB 超过 10MB 限制，已转为文件格式发送`,
        };
      }
      break;

    case "video":
      if (fileSize > VIDEO_MAX_BYTES) {
        return {
          finalType: "file",
          shouldReject: false,
          downgraded: true,
          downgradeNote: `视频大小 ${fileSizeMB}MB 超过 10MB 限制，已转为文件格式发送`,
        };
      }
      break;

    case "voice":
      // WeCom voice messages only support AMR format; non-AMR is always downgraded to file
      if (contentType && !VOICE_SUPPORTED_MIMES.has(contentType.toLowerCase())) {
        return {
          finalType: "file",
          shouldReject: false,
          downgraded: true,
          downgradeNote: `语音格式 ${contentType} 不支持，企微仅支持 AMR 格式，已转为文件格式发送`,
        };
      }
      if (fileSize > VOICE_MAX_BYTES) {
        return {
          finalType: "file",
          shouldReject: false,
          downgraded: true,
          downgradeNote: `语音大小 ${fileSizeMB}MB 超过 2MB 限制，已转为文件格式发送`,
        };
      }
      break;

    case "file":
      // file type is fine as long as it's within the absolute limit
      break;
  }

  // 无需降级
  return {
    finalType: detectedType,
    shouldReject: false,
    downgraded: false,
  };
}

// ============================================================================
// Helper functions
// ============================================================================

/**
 * Extract a filename from a URL/path
 */
function extractFileName(
  mediaUrl: string,
  providedFileName?: string,
  contentType?: string,
): string {
  // 优先使用提供的文件名
  if (providedFileName) {
    return providedFileName;
  }

  // 尝试从 URL 中提取
  try {
    const urlObj = new URL(mediaUrl, "file://");
    const pathParts = urlObj.pathname.split("/");
    const lastPart = pathParts[pathParts.length - 1];
    if (lastPart && lastPart.includes(".")) {
      return decodeURIComponent(lastPart);
    }
  } catch {
    // 尝试作为普通路径处理
    const parts = mediaUrl.split("/");
    const lastPart = parts[parts.length - 1];
    if (lastPart && lastPart.includes(".")) {
      return lastPart;
    }
  }

  // Generate a default filename from the MIME type
  const ext = mimeToExtension(contentType || "application/octet-stream");
  return `media_${Date.now()}${ext}`;
}

/**
 * Map MIME type to file extension
 */
function mimeToExtension(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/x-msvideo": ".avi",
    "video/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/amr": ".amr",
    "audio/aac": ".aac",
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "text/plain": ".txt",
  };
  return map[mime] || ".bin";
}

// ============================================================================
// Public media upload + send flow
// ============================================================================

/** Parameters for uploadAndSendMedia */
export interface UploadAndSendMediaOptions {
  /** WSClient instance */
  wsClient: WSClient;
  /** URL or local path of the media file */
  mediaUrl: string;
  /** Target chat ID (used for aibot_send_msg proactive sending) */
  chatId: string;
  /** Allowed local directory whitelist for reading local files */
  mediaLocalRoots?: readonly string[];
  /** Logging function */
  log?: (...args: unknown[]) => void;
  /** Error logging function */
  errorLog?: (...args: unknown[]) => void;
}

/** Return result of uploadAndSendMedia */
export interface UploadAndSendMediaResult {
  /** Whether sending succeeded */
  ok: boolean;
  /** messageId returned after sending */
  messageId?: string;
  /** Final WeCom media type */
  finalType?: WeComMediaType;
  /** Whether the file was rejected (too large) */
  rejected?: boolean;
  /** Rejection reason */
  rejectReason?: string;
  /** Whether a downgrade occurred */
  downgraded?: boolean;
  /** Downgrade explanation */
  downgradeNote?: string;
  /** Error message */
  error?: string;
}

/**
 * Public media upload + send flow
 *
 * Unified pipeline: resolveMediaFile → detectType → sizeCheck → uploadMedia → sendMediaMessage
 * Media messages are sent uniformly via aibot_send_msg (proactive send) to avoid the
 * reqId single-use limitation in multi-file scenarios.
 * Used by both channel.ts's sendMedia and monitor.ts's deliver callback.
 */
export async function uploadAndSendMedia(
  options: UploadAndSendMediaOptions,
): Promise<UploadAndSendMediaResult> {
  const { wsClient, mediaUrl, chatId, mediaLocalRoots, log, errorLog } = options;

  try {
    // 1. Load the media file
    log?.(`[wecom] Uploading media: url=${mediaUrl}`);
    const media = await resolveMediaFile(mediaUrl, mediaLocalRoots);

    // 2. Detect WeCom media type
    const detectedType = detectWeComMediaType(media.contentType);

    // 3. File size check and downgrade strategy
    const sizeCheck = applyFileSizeLimits(media.buffer.length, detectedType, media.contentType);

    if (sizeCheck.shouldReject) {
      errorLog?.(`[wecom] Media rejected: ${sizeCheck.rejectReason}`);
      return {
        ok: false,
        rejected: true,
        rejectReason: sizeCheck.rejectReason,
        finalType: sizeCheck.finalType,
      };
    }

    const finalType = sizeCheck.finalType;

    // 4. Chunked upload to obtain media_id
    const uploadResult = await wsClient.uploadMedia(media.buffer, {
      type: finalType,
      filename: media.fileName,
    });
    log?.(`[wecom] Media uploaded: media_id=${uploadResult.media_id}, type=${finalType}`);

    // 5. Send the media message uniformly via aibot_send_msg (proactive send)
    const result = await wsClient.sendMediaMessage(chatId, finalType, uploadResult.media_id);
    const messageId = result?.headers?.req_id ?? `wecom-media-${Date.now()}`;
    log?.(`[wecom] Media sent via sendMediaMessage: chatId=${chatId}, type=${finalType}`);

    return {
      ok: true,
      messageId,
      finalType,
      downgraded: sizeCheck.downgraded,
      downgradeNote: sizeCheck.downgradeNote,
    };
  } catch (err) {
    const errMsg = String(err);
    errorLog?.(`[wecom] Failed to upload/send media: url=${mediaUrl}, error=${errMsg}`);
    return {
      ok: false,
      error: errMsg,
    };
  }
}

// ============================================================================
// Passive reply media upload + send flow
// ============================================================================

/** Parameters for uploadAndReplyMedia */
export interface UploadAndReplyMediaOptions {
  /** WSClient instance */
  wsClient: WSClient;
  /** URL or local path of the media file */
  mediaUrl: string;
  /** Original WebSocket frame (used for aibot_respond_msg passive reply, carries req_id) */
  frame: WsFrameHeaders;
  /** Allowed local directory whitelist for reading local files */
  mediaLocalRoots?: readonly string[];
  /** Logging function */
  log?: (...args: unknown[]) => void;
  /** Error logging function */
  errorLog?: (...args: unknown[]) => void;
}

/**
 * Passive reply media upload + send flow
 *
 * Unified pipeline: resolveMediaFile → detectType → sizeCheck → uploadMedia → replyMedia
 * Sends media messages via the aibot_respond_msg passive reply channel, which can
 * overwrite a previous THINKING_MESSAGE.
 *
 * Use case: when the response contains only media and no text, the first media file
 * is sent via this method to clear the thinking state.
 */
export async function uploadAndReplyMedia(
  options: UploadAndReplyMediaOptions,
): Promise<UploadAndSendMediaResult> {
  const { wsClient, mediaUrl, frame, mediaLocalRoots, log, errorLog } = options;

  try {
    // 1. Load the media file
    log?.(`[wecom] Uploading media (reply mode): url=${mediaUrl}`);
    const media = await resolveMediaFile(mediaUrl, mediaLocalRoots);

    // 2. Detect WeCom media type
    const detectedType = detectWeComMediaType(media.contentType);

    // 3. File size check and downgrade strategy
    const sizeCheck = applyFileSizeLimits(media.buffer.length, detectedType, media.contentType);

    if (sizeCheck.shouldReject) {
      errorLog?.(`[wecom] Media rejected: ${sizeCheck.rejectReason}`);
      return {
        ok: false,
        rejected: true,
        rejectReason: sizeCheck.rejectReason,
        finalType: sizeCheck.finalType,
      };
    }

    const finalType = sizeCheck.finalType;

    // 4. Chunked upload to obtain media_id
    const uploadResult = await wsClient.uploadMedia(media.buffer, {
      type: finalType,
      filename: media.fileName,
    });
    log?.(`[wecom] Media uploaded: media_id=${uploadResult.media_id}, type=${finalType}`);

    // 5. Send media message via aibot_respond_msg passive reply (overwrites THINKING_MESSAGE)
    const result = await wsClient.replyMedia(frame, finalType, uploadResult.media_id);
    const messageId = result?.headers?.req_id ?? `wecom-reply-media-${Date.now()}`;
    log?.(`[wecom] Media sent via replyMedia (passive reply): type=${finalType}`);

    return {
      ok: true,
      messageId,
      finalType,
      downgraded: sizeCheck.downgraded,
      downgradeNote: sizeCheck.downgradeNote,
    };
  } catch (err) {
    const errMsg = String(err);
    errorLog?.(`[wecom] Failed to upload/reply media: url=${mediaUrl}, error=${errMsg}`);
    return {
      ok: false,
      error: errMsg,
    };
  }
}
