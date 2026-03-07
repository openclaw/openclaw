/**
 * 钉钉媒体处理
 *
 * 提供:
 * - uploadMediaDingtalk: 上传媒体到钉钉存储
 * - sendMediaDingtalk: 发送媒体消息
 * - processLocalImagesInMarkdown: 解析并上传本地图片（支持 MEDIA: 前缀）
 * - FileSizeLimitError: 文件大小超限错误
 * - TimeoutError: 下载超时错误
 *
 * API 文档:
 * - 上传媒体: https://open.dingtalk.com/document/orgapp/upload-media-files
 * - 发送图片: https://open.dingtalk.com/document/orgapp/chatbots-send-one-on-one-chat-messages-in-batches
 * - 下载文件: https://open.dingtalk.com/document/orgapp/download-the-file-content-of-the-robot-receiving-message
 */

import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import { getAccessToken } from "./client.js";
import type { Logger } from "./logger.js";
import { resolveExtension, extractImagesFromText } from "./shared/index.js";

/**
 * Error thrown when file size exceeds the limit for the message type
 *
 * @example
 * ```typescript
 * throw new FileSizeLimitError(15_000_000, 10_000_000, 'picture');
 * // Error: File size 15000000 bytes exceeds limit 10000000 bytes for picture
 * ```
 */
export class FileSizeLimitError extends Error {
  /** Actual file size in bytes */
  public readonly actualSize: number;
  /** Size limit in bytes for the message type */
  public readonly limitSize: number;
  /** Message type (picture, video, audio, file) */
  public readonly msgType: string;

  constructor(actualSize: number, limitSize: number, msgType: string) {
    super(`File size ${actualSize} bytes exceeds limit ${limitSize} bytes for ${msgType}`);
    this.name = "FileSizeLimitError";
    this.actualSize = actualSize;
    this.limitSize = limitSize;
    this.msgType = msgType;

    // Maintains proper stack trace for where error was thrown (V8 engines)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, FileSizeLimitError);
    }
  }
}

/**
 * Error thrown when download times out
 *
 * @example
 * ```typescript
 * throw new TimeoutError(120000);
 * // Error: Download timed out after 120000ms
 * ```
 */
export class TimeoutError extends Error {
  /** Timeout duration in milliseconds */
  public readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Download timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;

    // Maintains proper stack trace for where error was thrown (V8 engines)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TimeoutError);
    }
  }
}
import * as fs from "fs";
import type { DingtalkConfig, DingtalkSendResult } from "./types.js";

/** 钉钉 API 基础 URL */
const DINGTALK_API_BASE = "https://api.dingtalk.com";

/** 钉钉旧版 API 基础 URL (用于媒体上传) */
const DINGTALK_OAPI_BASE = "https://oapi.dingtalk.com";

/** HTTP 请求超时时间（毫秒） */
const REQUEST_TIMEOUT = 30000;

/** 媒体上传超时时间（毫秒） */
const UPLOAD_TIMEOUT = 60000;

/**
 * 媒体上传结果
 */
export interface UploadMediaResult {
  /** 媒体 ID */
  mediaId: string;
  /** 媒体类型 */
  type: "image" | "voice" | "video" | "file";
}

/**
 * 发送媒体参数
 */
export interface SendMediaParams {
  /** 钉钉配置 */
  cfg: DingtalkConfig;
  /** 目标 ID（用户 ID 或会话 ID） */
  to: string;
  /** 媒体 URL 或本地路径 */
  mediaUrl: string;
  /** 聊天类型 */
  chatType: "direct" | "group";
  /** 可选的媒体 Buffer */
  mediaBuffer?: Buffer;
  /** 可选的文件名 */
  fileName?: string;
}

/**
 * 检测媒体类型（基于文件名扩展名）
 *
 * @param fileName 文件名
 * @returns 媒体类型
 */
export function detectMediaType(fileName: string): "image" | "voice" | "video" | "file" {
  const ext = path.extname(fileName).toLowerCase();

  // 图片类型
  if ([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"].includes(ext)) {
    return "image";
  }

  // 音频类型
  if ([".mp3", ".wav", ".amr", ".opus", ".ogg"].includes(ext)) {
    return "voice";
  }

  // 视频类型
  if ([".mp4", ".mov", ".avi", ".mkv"].includes(ext)) {
    return "video";
  }

  // 其他文件
  return "file";
}

/**
 * 从 Content-Type 检测媒体类型
 *
 * @param contentType HTTP Content-Type 头
 * @returns 媒体类型
 */
export function detectMediaTypeFromContentType(
  contentType: string | null,
): "image" | "voice" | "video" | "file" {
  if (!contentType) return "file";

  const mime = contentType.split(";")[0].trim().toLowerCase();

  // 图片类型
  if (mime.startsWith("image/")) {
    return "image";
  }

  // 音频类型
  if (mime.startsWith("audio/")) {
    return "voice";
  }

  // 视频类型
  if (mime.startsWith("video/")) {
    return "video";
  }

  return "file";
}

/**
 * 从 Content-Type 推断文件扩展名
 *
 * @param contentType HTTP Content-Type 头
 * @returns 文件扩展名（含点号）或空字符串
 */
function getExtensionFromContentType(contentType: string | null): string {
  if (!contentType) return "";

  const mime = contentType.split(";")[0].trim().toLowerCase();

  const mimeToExt: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/amr": ".amr",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/x-msvideo": ".avi",
  };

  return mimeToExt[mime] ?? "";
}

/**
 * 检查是否为本地文件路径
 *
 * @param urlOrPath URL 或路径
 * @returns 是否为本地路径
 */
function isLocalPath(urlOrPath: string): boolean {
  // 以 / 或 ~ 开头，或 Windows 盘符
  if (urlOrPath.startsWith("/") || urlOrPath.startsWith("~") || /^[a-zA-Z]:/.test(urlOrPath)) {
    return true;
  }

  // 尝试解析为 URL
  try {
    const url = new URL(urlOrPath);
    return url.protocol === "file:";
  } catch {
    return true; // 不是有效 URL，视为本地路径
  }
}

/**
 * 上传媒体到钉钉存储
 *
 * 调用 /media/upload API
 *
 * @param params 上传参数
 * @returns 上传结果
 * @throws Error 如果上传失败
 */
export async function uploadMediaDingtalk(params: {
  cfg: DingtalkConfig;
  media: Buffer;
  fileName: string;
  mediaType: "image" | "voice" | "video" | "file";
}): Promise<UploadMediaResult> {
  const { cfg, media, fileName, mediaType } = params;

  // 验证凭证
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error("DingTalk credentials not configured (clientId, clientSecret required)");
  }

  // 获取 Access Token
  const accessToken = await getAccessToken(cfg.clientId, cfg.clientSecret);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT);

  try {
    // 构建 FormData
    const formData = new FormData();
    const blob = new Blob([new Uint8Array(media)], { type: "application/octet-stream" });
    formData.append("media", blob, fileName);
    formData.append("type", mediaType);

    const response = await fetch(
      `${DINGTALK_OAPI_BASE}/media/upload?access_token=${accessToken}&type=${mediaType}`,
      {
        method: "POST",
        body: formData,
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DingTalk media upload failed: HTTP ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as {
      errcode?: number;
      errmsg?: string;
      media_id?: string;
      type?: string;
    };

    if (data.errcode && data.errcode !== 0) {
      throw new Error(
        `DingTalk media upload failed: ${data.errmsg ?? "unknown error"} (code: ${data.errcode})`,
      );
    }

    if (!data.media_id) {
      throw new Error("DingTalk media upload failed: no media_id returned");
    }

    return {
      mediaId: data.media_id,
      type: mediaType,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`DingTalk media upload timed out after ${UPLOAD_TIMEOUT}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 发送媒体消息到钉钉
 *
 * 流程:
 * 1. 从 URL 或 Buffer 获取媒体数据
 * 2. 上传到钉钉媒体存储获取 media_id
 * 3. 使用 media_id 发送消息
 *
 * @param params 发送参数
 * @returns 发送结果
 * @throws Error 如果发送失败
 */
export async function sendMediaDingtalk(params: SendMediaParams): Promise<DingtalkSendResult> {
  const { cfg, to, mediaUrl, chatType, mediaBuffer, fileName } = params;

  // 验证凭证
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error("DingTalk credentials not configured (clientId, clientSecret required)");
  }

  let buffer: Buffer;
  let name: string;
  let detectedMediaType: "image" | "voice" | "video" | "file" | undefined;

  if (mediaBuffer) {
    // 使用提供的 Buffer
    buffer = mediaBuffer;
    name = fileName ?? "file";
  } else if (mediaUrl) {
    if (isLocalPath(mediaUrl)) {
      // 本地文件路径
      const filePath = mediaUrl.startsWith("~")
        ? mediaUrl.replace("~", process.env.HOME ?? "")
        : mediaUrl.replace("file://", "");

      if (!fs.existsSync(filePath)) {
        throw new Error(`Local file not found: ${filePath}`);
      }
      buffer = fs.readFileSync(filePath);
      name = fileName ?? path.basename(filePath);
    } else {
      // 远程 URL - 下载
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      try {
        const response = await fetch(mediaUrl, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Failed to fetch media from URL: HTTP ${response.status}`);
        }

        // 从 Content-Type 检测媒体类型
        const contentType = response.headers.get("content-type");
        detectedMediaType = detectMediaTypeFromContentType(contentType);

        buffer = Buffer.from(await response.arrayBuffer());

        // 构建文件名：优先使用提供的 fileName，否则从 URL 提取
        let baseName = fileName ?? (path.basename(new URL(mediaUrl).pathname) || "file");

        // 如果文件名没有扩展名，根据 Content-Type 添加
        if (!path.extname(baseName) && contentType) {
          const ext = getExtensionFromContentType(contentType);
          if (ext) {
            baseName = baseName + ext;
          }
        }
        name = baseName;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new Error(`Media download timed out after ${REQUEST_TIMEOUT}ms`);
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
    }
  } else {
    throw new Error("Either mediaUrl or mediaBuffer must be provided");
  }

  // 检测媒体类型：优先使用从 Content-Type 检测到的类型，否则从文件名推断
  const mediaType = detectedMediaType ?? detectMediaType(name);

  // 上传媒体
  const uploadResult = await uploadMediaDingtalk({
    cfg,
    media: buffer,
    fileName: name,
    mediaType,
  });

  // 获取 Access Token
  const accessToken = await getAccessToken(cfg.clientId, cfg.clientSecret);

  // 发送媒体消息
  if (chatType === "direct") {
    return sendDirectMediaMessage({
      cfg,
      to,
      mediaId: uploadResult.mediaId,
      mediaType,
      accessToken,
      fileName: name,
    });
  } else {
    return sendGroupMediaMessage({
      cfg,
      to,
      mediaId: uploadResult.mediaId,
      mediaType,
      accessToken,
      fileName: name,
    });
  }
}

/**
 * 处理 Markdown 中的本地图片路径（含 MEDIA: 前缀），并替换为 media_id
 * 使用 shared 模块的 extractImagesFromText 实现
 */
export async function processLocalImagesInMarkdown(params: {
  text: string;
  cfg: DingtalkConfig;
  log?: Logger;
  cache?: Map<string, string>;
}): Promise<string> {
  const { text, cfg, log, cache } = params;
  const mediaCache = cache ?? new Map<string, string>();

  // 使用 shared 模块提取图片
  const { images } = extractImagesFromText(text, {
    removeFromText: false, // 我们需要手动替换为 media_id
    checkExists: true,
    existsSync: (p: string) => {
      const exists = fs.existsSync(p);
      if (!exists) {
        log?.warn?.(`[dingtalk] local image not found: ${p}`);
      }
      return exists;
    },
    parseMarkdownImages: true,
    parseHtmlImages: false, // 钉钉不支持 HTML
    parseBarePaths: true,
  });

  // 过滤出本地图片
  const localImages = images.filter((img) => img.isLocal && img.localPath);

  if (localImages.length === 0) {
    return text;
  }

  // 上传图片并获取 media_id
  const getMediaId = async (localPath: string): Promise<string> => {
    const cached = mediaCache.get(localPath);
    if (cached) return cached;
    const buffer = await fsPromises.readFile(localPath);
    const fileName = path.basename(localPath);
    const upload = await uploadMediaDingtalk({
      cfg,
      media: buffer,
      fileName,
      mediaType: "image",
    });
    mediaCache.set(localPath, upload.mediaId);
    return upload.mediaId;
  };

  let result = text;

  // 替换图片路径为 media_id
  for (const img of localImages) {
    if (!img.localPath) continue;

    try {
      const mediaId = await getMediaId(img.localPath);

      // 替换 Markdown 图片语法: ![...](source)
      const escapedSource = img.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const mdPattern = new RegExp(`!\\[([^\\]]*)\\]\\(${escapedSource}\\)`, "g");
      result = result.replace(mdPattern, `![$1](${mediaId})`);

      // 替换裸露的路径（非 Markdown 格式）
      // 直接替换原始 source（如 MEDIA:path 或裸露路径）
      if (result.includes(img.source)) {
        result = result.split(img.source).join(`![](${mediaId})`);
      }
    } catch (err) {
      log?.warn?.(`[dingtalk] failed to upload image ${img.localPath}: ${err}`);
    }
  }

  return result;
}

/**
 * 获取媒体消息的 msgKey
 *
 * @param mediaType 媒体类型
 * @returns msgKey
 */
function getMsgKeyForMediaType(mediaType: "image" | "voice" | "video" | "file"): string {
  switch (mediaType) {
    case "image":
      return "sampleImageMsg";
    case "voice":
      return "sampleAudio";
    case "video":
      return "sampleVideo";
    case "file":
      return "sampleFile";
    default:
      return "sampleFile";
  }
}

/**
 * 构建媒体消息参数
 *
 * @param mediaId 媒体 ID
 * @param mediaType 媒体类型
 * @param fileName 文件名（用于 file 类型）
 * @returns msgParam JSON 字符串
 */
function buildMediaMsgParam(
  mediaId: string,
  mediaType: "image" | "voice" | "video" | "file",
  fileName?: string,
): string {
  switch (mediaType) {
    case "image":
      return JSON.stringify({ photoURL: mediaId });
    case "voice":
      return JSON.stringify({ mediaId, duration: "1000" });
    case "video":
      return JSON.stringify({
        videoMediaId: mediaId,
        videoType: "mp4",
        duration: "1000",
      });
    case "file":
      return JSON.stringify({ mediaId, fileName: fileName ?? "file", fileType: "file" });
    default:
      return JSON.stringify({ mediaId });
  }
}

/**
 * 发送单聊媒体消息
 *
 * @internal
 */
async function sendDirectMediaMessage(params: {
  cfg: DingtalkConfig;
  to: string;
  mediaId: string;
  mediaType: "image" | "voice" | "video" | "file";
  accessToken: string;
  fileName?: string;
}): Promise<DingtalkSendResult> {
  const { cfg, to, mediaId, mediaType, accessToken, fileName } = params;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(`${DINGTALK_API_BASE}/v1.0/robot/oToMessages/batchSend`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      body: JSON.stringify({
        robotCode: cfg.clientId,
        userIds: [to],
        msgKey: getMsgKeyForMediaType(mediaType),
        msgParam: buildMediaMsgParam(mediaId, mediaType, fileName),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DingTalk direct media send failed: HTTP ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as {
      processQueryKey?: string;
    };

    return {
      messageId: data.processQueryKey ?? `dm_media_${Date.now()}`,
      conversationId: to,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`DingTalk direct media send timed out after ${REQUEST_TIMEOUT}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 发送群聊媒体消息
 *
 * @internal
 */
async function sendGroupMediaMessage(params: {
  cfg: DingtalkConfig;
  to: string;
  mediaId: string;
  mediaType: "image" | "voice" | "video" | "file";
  accessToken: string;
  fileName?: string;
}): Promise<DingtalkSendResult> {
  const { cfg, to, mediaId, mediaType, accessToken, fileName } = params;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(`${DINGTALK_API_BASE}/v1.0/robot/groupMessages/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      body: JSON.stringify({
        robotCode: cfg.clientId,
        openConversationId: to,
        msgKey: getMsgKeyForMediaType(mediaType),
        msgParam: buildMediaMsgParam(mediaId, mediaType, fileName),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DingTalk group media send failed: HTTP ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as {
      processQueryKey?: string;
    };

    return {
      messageId: data.processQueryKey ?? `gm_media_${Date.now()}`,
      conversationId: to,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`DingTalk group media send timed out after ${REQUEST_TIMEOUT}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// Media Receiving Functions
// ============================================================================

/**
 * Supported media message types for extraction
 */
export type MediaMsgType = "picture" | "video" | "audio" | "file";

/**
 * Extracted file information from a DingTalk message
 */
export interface ExtractedFileInfo {
  /** Download code for retrieving the file */
  downloadCode: string;
  /** Message type */
  msgType: MediaMsgType;
  /** Original file name (file type only) */
  fileName?: string;
  /** File size in bytes (file type only) */
  fileSize?: number;
  /** Duration in milliseconds (audio/video) */
  duration?: number;
  /** Speech recognition text (audio only) */
  recognition?: string;
}

/**
 * Content structure for media messages
 * @internal
 */
interface MediaContent {
  downloadCode?: string;
  pictureDownloadCode?: string;
  videoDownloadCode?: string;
  duration?: number;
  recognition?: string;
  fileName?: string;
  fileSize?: number;
}

/**
 * Parse content field which may be a JSON string or object
 * @internal
 */
function parseContent(content: unknown): MediaContent | null {
  if (!content) return null;

  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content);
      // Ensure parsed result is an object, not an array
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as MediaContent;
      }
      return null;
    } catch {
      return null;
    }
  }

  // Ensure content is an object, not an array
  if (typeof content === "object" && !Array.isArray(content)) {
    return content as MediaContent;
  }

  return null;
}

/**
 * Extract download code with fallback for picture/video types
 * @internal
 */
function extractDownloadCode(content: MediaContent, msgType: MediaMsgType): string | null {
  // Primary: downloadCode
  if (content.downloadCode) {
    return content.downloadCode;
  }

  // Fallback for picture type
  if (msgType === "picture" && content.pictureDownloadCode) {
    return content.pictureDownloadCode;
  }

  // Fallback for video type
  if (msgType === "video" && content.videoDownloadCode) {
    return content.videoDownloadCode;
  }

  return null;
}

/**
 * Extract file information from a DingTalk message
 *
 * Handles picture, video, audio, and file message types.
 * Supports both object and JSON string content formats.
 *
 * @param data Raw message data from DingTalk Stream SDK
 * @returns Extracted file info or null if not a media message
 *
 * @example
 * ```typescript
 * const fileInfo = extractFileFromMessage(rawMessage);
 * if (fileInfo) {
 *   console.log(`Download code: ${fileInfo.downloadCode}`);
 *   console.log(`Type: ${fileInfo.msgType}`);
 * }
 * ```
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */
export function extractFileFromMessage(data: unknown): ExtractedFileInfo | null {
  // Validate input is an object
  if (!data || typeof data !== "object") {
    return null;
  }

  const msg = data as Record<string, unknown>;

  // Get message type
  const msgtype = msg.msgtype;
  if (typeof msgtype !== "string") {
    return null;
  }

  // Check if it's a supported media type
  const supportedTypes: MediaMsgType[] = ["picture", "video", "audio", "file"];
  if (!supportedTypes.includes(msgtype as MediaMsgType)) {
    return null;
  }

  const msgType = msgtype as MediaMsgType;

  // Parse content (may be string or object)
  const content = parseContent(msg.content);
  if (!content) {
    return null;
  }

  // Extract download code with fallback
  const downloadCode = extractDownloadCode(content, msgType);
  if (!downloadCode) {
    return null;
  }

  // Build result based on message type
  const result: ExtractedFileInfo = {
    downloadCode,
    msgType,
  };

  // Add type-specific fields
  switch (msgType) {
    case "picture":
      // Picture has no additional fields
      break;

    case "video":
      // Video has duration
      if (typeof content.duration === "number") {
        result.duration = content.duration;
      }
      break;

    case "audio":
      // Audio has duration and recognition
      if (typeof content.duration === "number") {
        result.duration = content.duration;
      }
      if (typeof content.recognition === "string") {
        result.recognition = content.recognition;
      }
      break;

    case "file":
      // File has fileName and fileSize
      if (typeof content.fileName === "string") {
        result.fileName = content.fileName;
      }
      if (typeof content.fileSize === "number") {
        result.fileSize = content.fileSize;
      }
      break;
  }

  return result;
}

/**
 * Rich text element structure from DingTalk
 */
export interface RichTextElement {
  /** Element type: text, picture, or at */
  type: "text" | "picture" | "at";
  /** Text content (for text type) */
  text?: string;
  /** Download code (for picture type) */
  downloadCode?: string;
  /** Fallback download code (for picture type) */
  pictureDownloadCode?: string;
  /** User ID (for at/mention type) */
  userId?: string;
}

/**
 * Parsed rich text message result
 */
export interface RichTextParseResult {
  /** Array of text parts (to be joined with newlines) */
  textParts: string[];
  /** Download codes for images */
  imageCodes: string[];
  /** Mentioned user IDs */
  mentions: string[];
  /** Ordered richText elements */
  elements: RichTextElement[];
}

/**
 * Parse richText field which may be a JSON string or array
 * @internal
 */
function parseRichText(richText: unknown): RichTextElement[] | null {
  if (!richText) return null;

  if (typeof richText === "string") {
    try {
      const parsed = JSON.parse(richText);
      if (Array.isArray(parsed)) {
        return parsed as RichTextElement[];
      }
      return null;
    } catch {
      return null;
    }
  }

  if (Array.isArray(richText)) {
    return richText as RichTextElement[];
  }

  return null;
}

/**
 * Parse content field for richText messages (may be JSON string or object)
 * @internal
 */
function parseRichTextContent(content: unknown): Record<string, unknown> | null {
  if (!content) return null;

  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }

  if (typeof content === "object" && !Array.isArray(content)) {
    return content as Record<string, unknown>;
  }

  return null;
}

/**
 * Parse a richText message from DingTalk
 *
 * Extracts text elements, picture download codes, and mentions from
 * a richText message. Supports both array and JSON string formats for
 * both the content field and the richText field within it.
 *
 * @param data Raw message data from DingTalk Stream SDK
 * @returns Parsed result or null if invalid/not a richText message
 *
 * @example
 * ```typescript
 * const result = parseRichTextMessage(rawMessage);
 * if (result) {
 *   const fullText = result.textParts.join('\n');
 *   console.log(`Text: ${fullText}`);
 *   console.log(`Images: ${result.imageCodes.length}`);
 *   console.log(`Mentions: ${result.mentions.join(', ')}`);
 * }
 * ```
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */
export function parseRichTextMessage(data: unknown): RichTextParseResult | null {
  // Validate input is an object
  if (!data || typeof data !== "object") {
    return null;
  }

  const msg = data as Record<string, unknown>;

  // Check if it's a richText message type
  if (msg.msgtype !== "richText") {
    return null;
  }

  // Parse content field (may be JSON string or object) - Requirement 3.4
  const contentObj = parseRichTextContent(msg.content);
  if (!contentObj) {
    return null;
  }

  // Parse richText array (may be string or array)
  const richTextElements = parseRichText(contentObj.richText);
  if (!richTextElements || richTextElements.length === 0) {
    return null;
  }

  const textParts: string[] = [];
  const imageCodes: string[] = [];
  const mentions: string[] = [];
  const orderedElements: RichTextElement[] = [];

  // Process each element
  for (const element of richTextElements) {
    if (!element || typeof element !== "object") {
      continue;
    }

    const elementType = element.type;
    const hasText = typeof element.text === "string";

    // Some DingTalk richText elements omit "type" for text nodes.
    if (!elementType && hasText) {
      textParts.push(element.text as string);
      orderedElements.push({ type: "text", text: element.text as string });
      continue;
    }

    switch (elementType) {
      case "text":
        // Extract text content
        if (hasText) {
          textParts.push(element.text as string);
          orderedElements.push({ type: "text", text: element.text as string });
        }
        break;

      case "picture": {
        // Extract download code with fallback
        const code = element.downloadCode || element.pictureDownloadCode;
        if (typeof code === "string" && code) {
          imageCodes.push(code);
          orderedElements.push({ type: "picture", downloadCode: code });
        }
        break;
      }

      case "at":
        // Extract user ID (singular, as per DingTalk API)
        if (typeof element.userId === "string" && element.userId) {
          mentions.push(element.userId);
          orderedElements.push({ type: "at", userId: element.userId });
        }
        break;
    }
  }

  return {
    textParts,
    imageCodes,
    mentions,
    elements: orderedElements,
  };
}

// ============================================================================
// File Download Functions
// ============================================================================

/**
 * File size limits by message type (in bytes)
 */
const FILE_SIZE_LIMITS: Record<string, number> = {
  picture: 100 * 1024 * 1024, // 100MB
  video: 100 * 1024 * 1024, // 100MB
  audio: 100 * 1024 * 1024, // 100MB
  file: 100 * 1024 * 1024, // 100MB
};

/** Download timeout in milliseconds (120 seconds) */
const DOWNLOAD_TIMEOUT = 120_000;

/**
 * Downloaded file information
 */
export interface DownloadedFile {
  /** Absolute path to the downloaded file */
  path: string;
  /** MIME content type */
  contentType: string;
  /** File size in bytes */
  size: number;
  /** Original file name (if available) */
  fileName?: string;
}

/**
 * Parameters for downloading a file from DingTalk
 */
export interface DownloadDingTalkFileParams {
  /** Download code from the message */
  downloadCode: string;
  /** Robot code (clientId) */
  robotCode: string;
  /** Access token for API authentication */
  accessToken: string;
  /** Original file name (optional, used for extension resolution) */
  fileName?: string;
  /** Message type for size limit enforcement */
  msgType?: MediaMsgType;
  /** Logger instance (optional) */
  log?: Logger;
  /** Max file size in MB (optional, defaults to 100MB) */
  maxFileSizeMB?: number;
}

/**
 * Download a file from DingTalk using downloadCode
 *
 * Download flow:
 * 1. POST to DingTalk API with downloadCode to get downloadUrl
 * 2. GET request to downloadUrl
 * 3. Check Content-Length header against size limit for msgType
 *    - If Content-Length present and exceeds limit: abort immediately, throw FileSizeLimitError
 *    - If Content-Length absent: proceed to streaming download
 * 4. Stream response body while counting bytes
 *    - If accumulated bytes exceed limit: abort stream, throw FileSizeLimitError
 * 5. Save to os.tmpdir() with appropriate extension
 *
 * @param params Download parameters
 * @returns Downloaded file information
 * @throws Error if API returns error or downloadUrl is missing
 * @throws TimeoutError if download exceeds 120 seconds
 * @throws FileSizeLimitError if file exceeds size limit for msgType
 *
 * @example
 * ```typescript
 * const file = await downloadDingTalkFile({
 *   downloadCode: 'abc123',
 *   robotCode: 'dingxxx',
 *   accessToken: 'token',
 *   msgType: 'picture',
 * });
 * console.log(`Downloaded to: ${file.path}`);
 * ```
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
 */
export async function downloadDingTalkFile(
  params: DownloadDingTalkFileParams,
): Promise<DownloadedFile> {
  const { downloadCode, robotCode, accessToken, fileName, log, maxFileSizeMB } = params;
  // Default msgType to "file" to ensure size limits are always enforced
  const msgType = params.msgType ?? "file";

  // Calculate size limit: use config value if provided, otherwise use default
  const defaultLimit = FILE_SIZE_LIMITS[msgType] ?? FILE_SIZE_LIMITS.file;
  const sizeLimit = maxFileSizeMB ? maxFileSizeMB * 1024 * 1024 : defaultLimit;

  // Step 1: Get download URL from DingTalk API (with separate timeout)
  const apiController = new AbortController();
  const apiTimeoutId = setTimeout(() => apiController.abort(), REQUEST_TIMEOUT);

  let downloadUrl: string;

  try {
    log?.debug?.(`Getting download URL for code: ${downloadCode.slice(0, 10)}...`);

    const apiResponse = await fetch(`${DINGTALK_API_BASE}/v1.0/robot/messageFiles/download`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      body: JSON.stringify({
        downloadCode,
        robotCode,
      }),
      signal: apiController.signal,
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      throw new Error(`DingTalk API error: HTTP ${apiResponse.status} - ${errorText}`);
    }

    const apiData = (await apiResponse.json()) as { downloadUrl?: string };

    if (!apiData.downloadUrl) {
      throw new Error("DingTalk API returned no downloadUrl");
    }

    downloadUrl = apiData.downloadUrl;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`DingTalk API request timed out after ${REQUEST_TIMEOUT}ms`);
    }
    throw err;
  } finally {
    clearTimeout(apiTimeoutId);
  }

  log?.debug?.(`Got download URL, starting download...`);

  // Step 2: Download the file (with dedicated 120s timeout)
  const downloadController = new AbortController();
  const downloadTimeoutId = setTimeout(() => downloadController.abort(), DOWNLOAD_TIMEOUT);

  try {
    const fileResponse = await fetch(downloadUrl, {
      signal: downloadController.signal,
    });

    if (!fileResponse.ok) {
      throw new Error(`File download failed: HTTP ${fileResponse.status}`);
    }

    // Get content type and content length
    const contentType = fileResponse.headers.get("content-type") || "application/octet-stream";
    const contentLengthHeader = fileResponse.headers.get("content-length");
    const contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : null;

    // Step 3: Check Content-Length against size limit
    if (contentLength !== null && contentLength > sizeLimit) {
      // Abort immediately without downloading body
      downloadController.abort();
      throw new FileSizeLimitError(contentLength, sizeLimit, msgType);
    }

    // Step 4: Stream response body while counting bytes
    const body = fileResponse.body;
    if (!body) {
      throw new Error("Response body is null");
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const reader = body.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        totalBytes += value.length;

        // Check size limit during streaming (when Content-Length was absent)
        if (totalBytes > sizeLimit) {
          reader.cancel();
          throw new FileSizeLimitError(totalBytes, sizeLimit, msgType);
        }

        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    // Combine chunks into buffer
    const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));

    // Step 5: Save to tmpdir with correct extension
    const extension = resolveExtension(contentType, fileName);
    const ts = Date.now();
    const rnd = Math.random().toString(36).slice(2, 8);
    const tempFileName = `dingtalk-file-${ts}-${rnd}${extension}`;
    const tmpDir = os.tmpdir();
    const tempFilePath = path.join(tmpDir, tempFileName);

    await fsPromises.writeFile(tempFilePath, buffer);

    log?.debug?.(`File saved to: ${tempFilePath} (${totalBytes} bytes)`);

    return {
      path: tempFilePath,
      contentType,
      size: totalBytes,
      fileName,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new TimeoutError(DOWNLOAD_TIMEOUT);
    }
    throw err;
  } finally {
    clearTimeout(downloadTimeoutId);
  }
}

/**
 * Parameters for downloading rich text images
 */
export interface DownloadRichTextImagesParams {
  /** Download codes for images */
  imageCodes: string[];
  /** Robot code (clientId) */
  robotCode: string;
  /** Access token for API authentication */
  accessToken: string;
  /** Logger instance (optional) */
  log?: Logger;
  /** Max file size in MB (optional, defaults to 100MB) */
  maxFileSizeMB?: number;
}

/**
 * Download all images from a richText message
 *
 * Downloads images sequentially to avoid overwhelming DingTalk API rate limits.
 * Continues on individual failures and collects successful downloads.
 *
 * @param params Download parameters
 * @returns Array of successfully downloaded files (may be partial if some fail)
 *
 * @example
 * ```typescript
 * const files = await downloadRichTextImages({
 *   imageCodes: ['code1', 'code2', 'code3'],
 *   robotCode: 'dingxxx',
 *   accessToken: 'token',
 * });
 * console.log(`Downloaded ${files.length} images`);
 * ```
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4
 */
export async function downloadRichTextImages(
  params: DownloadRichTextImagesParams,
): Promise<DownloadedFile[]> {
  const { imageCodes, robotCode, accessToken, log, maxFileSizeMB } = params;

  const results: DownloadedFile[] = [];
  const total = imageCodes.length;

  for (let i = 0; i < total; i++) {
    const code = imageCodes[i];
    const index = i + 1; // 1-based for logging

    // Log progress (Requirement 4.4)
    log?.info?.(`downloading image ${index}/${total}`);

    try {
      // Download sequentially (Requirement 4.1)
      const file = await downloadDingTalkFile({
        downloadCode: code,
        robotCode,
        accessToken,
        msgType: "picture",
        log,
        maxFileSizeMB,
      });

      results.push(file);
    } catch (err) {
      // Log warning and continue (Requirement 4.2)
      const errorMessage = err instanceof Error ? err.message : String(err);
      log?.warn?.(`Failed to download image ${index}/${total}: ${errorMessage}`);
      // Continue with remaining images
    }
  }

  // Return successful downloads (Requirement 4.3)
  return results;
}

/**
 * Clean up a temporary file
 *
 * Deletes the file at the specified path. Silently ignores ENOENT errors
 * (file not found) and logs debug messages for other errors.
 *
 * @param filePath Path to delete (optional, no-op if undefined)
 * @param log Logger instance (optional)
 *
 * @example
 * ```typescript
 * await cleanupFile('/tmp/dingtalk-file-123.jpg');
 * ```
 *
 * Requirements: 8.1, 8.3, 8.4
 */
export async function cleanupFile(filePath?: string, log?: Logger): Promise<void> {
  if (!filePath) {
    return;
  }

  try {
    await fsPromises.unlink(filePath);
  } catch (err) {
    // Silently ignore ENOENT (file not found) errors (Requirement 8.3)
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    // Log debug for other errors (Requirement 8.4)
    const errorMessage = err instanceof Error ? err.message : String(err);
    log?.debug?.(`Failed to cleanup file ${filePath}: ${errorMessage}`);
  }
}
