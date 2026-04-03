/**
 * 企业微信出站媒体上传工具模块
 *
 * 负责：
 * - 从 mediaUrl 加载文件 buffer（远程 URL 或本地路径均支持）
 * - 检测 MIME 类型并映射为企微媒体类型
 * - 文件大小检查与降级策略
 */

import type { WeComMediaType, WSClient, WsFrameHeaders } from "@wecom/aibot-node-sdk";
import {
  loadOutboundMediaFromUrl,
  detectMime,
  type WebMediaResult,
} from "./openclaw-compat.js";
import {
  IMAGE_MAX_BYTES,
  VIDEO_MAX_BYTES,
  VOICE_MAX_BYTES,
  FILE_MAX_BYTES,
  ABSOLUTE_MAX_BYTES,
} from "./const.js";

// ============================================================================
// 类型定义
// ============================================================================

/** 媒体文件解析结果 */
export interface ResolvedMedia {
  /** 文件数据 */
  buffer: Buffer;
  /** 检测到的 MIME 类型 */
  contentType: string;
  /** 文件名（从 URL 提取或默认生成） */
  fileName: string;
}

/** 文件大小检查结果 */
export interface FileSizeCheckResult {
  /** 最终确定的企微媒体类型（可能被降级） */
  finalType: WeComMediaType;
  /** 是否需要拒绝（超过绝对限制） */
  shouldReject: boolean;
  /** 拒绝原因（仅 shouldReject=true 时有值） */
  rejectReason?: string;
  /** 是否发生了降级 */
  downgraded: boolean;
  /** 降级说明（仅 downgraded=true 时有值） */
  downgradeNote?: string;
}

// ============================================================================
// MIME → 企微媒体类型映射
// ============================================================================

/**
 * 根据 MIME 类型检测企微媒体类型
 *
 * @param mimeType - MIME 类型字符串
 * @returns 企微媒体类型
 */
export function detectWeComMediaType(mimeType: string): WeComMediaType {
  const mime = mimeType.toLowerCase();

  // 图片类型
  if (mime.startsWith("image/")) {
    return "image";
  }

  // 视频类型
  if (mime.startsWith("video/")) {
    return "video";
  }

  // 语音类型
  if (
    mime.startsWith("audio/") ||
    mime === "application/ogg" // OGG 音频容器
  ) {
    return "voice";
  }

  // 其他类型默认为文件
  return "file";
}

// ============================================================================
// 媒体文件加载
// ============================================================================

/**
 * 从 mediaUrl 加载媒体文件
 *
 * 支持远程 URL（http/https）和本地路径（file:// 或绝对路径），
 * 利用 openclaw plugin-sdk 的 loadOutboundMediaFromUrl 统一处理。
 *
 * @param mediaUrl - 媒体文件的 URL 或本地路径
 * @param mediaLocalRoots - 允许读取本地文件的安全白名单目录
 * @returns 解析后的媒体文件信息
 */
export async function resolveMediaFile(
  mediaUrl: string,
  mediaLocalRoots?: readonly string[],
): Promise<ResolvedMedia> {
  // 使用兼容层加载媒体文件（优先 SDK，不可用时 fallback）
  // 传入足够大的 maxBytes，由我们自己在后续步骤做大小检查
  const result: WebMediaResult = await loadOutboundMediaFromUrl(mediaUrl, {
    maxBytes: ABSOLUTE_MAX_BYTES,
    mediaLocalRoots,
  });

  if (!result.buffer || result.buffer.length === 0) {
    throw new Error(`Failed to load media from ${mediaUrl}: empty buffer`);
  }

  // 检测真实 MIME 类型
  let contentType = result.contentType || "application/octet-stream";

  // 如果没有返回准确的 contentType，尝试通过 buffer 魔术字节检测
  if (
    contentType === "application/octet-stream" ||
    contentType === "text/plain"
  ) {
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

  // 先检查绝对上限（20MB）
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
      // 企微语音消息仅支持 AMR 格式，非 AMR 一律降级为文件
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
      // file 类型在绝对上限内即可
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
// 辅助函数
// ============================================================================

/**
 * 从 URL/路径中提取文件名
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

  // 使用 MIME 类型生成默认文件名
  const ext = mimeToExtension(contentType || "application/octet-stream");
  return `media_${Date.now()}${ext}`;
}

/**
 * MIME 类型转文件扩展名
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
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      ".xlsx",
    "text/plain": ".txt",
  };
  return map[mime] || ".bin";
}

// ============================================================================
// 公共媒体上传+发送流程
// ============================================================================

/** uploadAndSendMedia 的参数 */
export interface UploadAndSendMediaOptions {
  /** WSClient 实例 */
  wsClient: WSClient;
  /** 媒体文件的 URL 或本地路径 */
  mediaUrl: string;
  /** 目标会话 ID（用于 aibot_send_msg 主动发送） */
  chatId: string;
  /** 允许读取本地文件的安全白名单目录 */
  mediaLocalRoots?: readonly string[];
  /** 日志函数 */
  log?: (...args: any[]) => void;
  /** 错误日志函数 */
  errorLog?: (...args: any[]) => void;
}

/** uploadAndSendMedia 的返回结果 */
export interface UploadAndSendMediaResult {
  /** 是否发送成功 */
  ok: boolean;
  /** 发送后返回的 messageId */
  messageId?: string;
  /** 最终的企微媒体类型 */
  finalType?: WeComMediaType;
  /** 是否被拒绝（文件过大） */
  rejected?: boolean;
  /** 拒绝原因 */
  rejectReason?: string;
  /** 是否发生了降级 */
  downgraded?: boolean;
  /** 降级说明 */
  downgradeNote?: string;
  /** 错误信息 */
  error?: string;
}

/**
 * 公共媒体上传+发送流程
 *
 * 统一处理：resolveMediaFile → detectType → sizeCheck → uploadMedia → sendMediaMessage
 * 媒体消息统一走 aibot_send_msg 主动发送，避免多文件场景下 reqId 只能用一次的问题。
 * channel.ts 的 sendMedia 和 monitor.ts 的 deliver 回调都使用此函数。
 */
export async function uploadAndSendMedia(
  options: UploadAndSendMediaOptions,
): Promise<UploadAndSendMediaResult> {
  const { wsClient, mediaUrl, chatId, mediaLocalRoots, log, errorLog } = options;

  try {
    // 1. 加载媒体文件
    log?.(`[wecom] Uploading media: url=${mediaUrl}`);
    const media = await resolveMediaFile(mediaUrl, mediaLocalRoots);

    // 2. 检测企微媒体类型
    const detectedType = detectWeComMediaType(media.contentType);

    // 3. 文件大小检查与降级策略
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

    // 4. 分片上传获取 media_id
    const uploadResult = await wsClient.uploadMedia(media.buffer, {
      type: finalType,
      filename: media.fileName,
    });
    log?.(`[wecom] Media uploaded: media_id=${uploadResult.media_id}, type=${finalType}`);

    // 5. 统一通过 aibot_send_msg 主动发送媒体消息
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
// 被动回复媒体上传+发送流程
// ============================================================================

/** uploadAndReplyMedia 的参数 */
export interface UploadAndReplyMediaOptions {
  /** WSClient 实例 */
  wsClient: WSClient;
  /** 媒体文件的 URL 或本地路径 */
  mediaUrl: string;
  /** 原始 WebSocket 帧（用于 aibot_respond_msg 被动回复，携带 req_id） */
  frame: WsFrameHeaders;
  /** 允许读取本地文件的安全白名单目录 */
  mediaLocalRoots?: readonly string[];
  /** 日志函数 */
  log?: (...args: any[]) => void;
  /** 错误日志函数 */
  errorLog?: (...args: any[]) => void;
}

/**
 * 被动回复媒体上传+发送流程
 *
 * 统一处理：resolveMediaFile → detectType → sizeCheck → uploadMedia → replyMedia
 * 通过 aibot_respond_msg 被动回复通道发送媒体消息，可以覆盖之前的 THINKING_MESSAGE。
 *
 * 适用场景：回包只有媒体没有文本时，第一个媒体文件用此方法发送以清理 thinking 状态。
 */
export async function uploadAndReplyMedia(
  options: UploadAndReplyMediaOptions,
): Promise<UploadAndSendMediaResult> {
  const { wsClient, mediaUrl, frame, mediaLocalRoots, log, errorLog } = options;

  try {
    // 1. 加载媒体文件
    log?.(`[wecom] Uploading media (reply mode): url=${mediaUrl}`);
    const media = await resolveMediaFile(mediaUrl, mediaLocalRoots);

    // 2. 检测企微媒体类型
    const detectedType = detectWeComMediaType(media.contentType);

    // 3. 文件大小检查与降级策略
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

    // 4. 分片上传获取 media_id
    const uploadResult = await wsClient.uploadMedia(media.buffer, {
      type: finalType,
      filename: media.fileName,
    });
    log?.(`[wecom] Media uploaded: media_id=${uploadResult.media_id}, type=${finalType}`);

    // 5. 通过 aibot_respond_msg 被动回复发送媒体消息（会覆盖 THINKING_MESSAGE）
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
