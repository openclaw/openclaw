/**
 * Media Sender for DingTalk.
 *
 * Handles uploading and sending media files (images, files, videos, audio)
 * via sessionWebhook or proactive API.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolvedDingTalkAccount } from "../accounts.js";
import type { TokenManager } from "../api/token-manager.js";
import type { MediaItem } from "../media-protocol.js";
import type { StreamLogger } from "../stream/types.js";
import { uploadMediaToOAPI, detectMediaType } from "../api/media-upload.js";
import { uploadMedia } from "../api/media.js";
import { sendImageWithMediaIdViaSessionWebhook, type ReplyLogger } from "./reply.js";

/**
 * Result of sending a media item.
 */
export interface SendMediaResult {
  ok: boolean;
  error?: string;
  mediaId?: string;
}

/**
 * Options for media sending.
 */
export interface MediaSendOptions {
  account: ResolvedDingTalkAccount;
  sessionWebhook: string;
  tokenManager: TokenManager;
  logger?: StreamLogger;
}

/**
 * Maximum file size for DingTalk uploads (20MB).
 */
const MAX_FILE_SIZE = 20 * 1024 * 1024;

/**
 * Sends a single media item via sessionWebhook.
 *
 * The process is:
 * 1. Check file exists and size
 * 2. Upload to DingTalk to get mediaId
 * 3. Send appropriate message type via sessionWebhook
 */
/**
 * Uploads a media item to DingTalk and returns the mediaId.
 */
export async function uploadMediaItem(
  item: MediaItem,
  options: MediaSendOptions,
): Promise<{ ok: boolean; mediaId?: string; error?: string; fileName?: string }> {
  const { account, tokenManager, logger } = options;
  const { path: filePath, name } = item;

  // 1. Check file exists
  if (!fs.existsSync(filePath)) {
    const error = `文件不存在: ${filePath}`;
    logger?.warn?.({ path: filePath }, "Media file not found");
    return { ok: false, error };
  }

  // 2. Check file size
  try {
    const stats = fs.statSync(filePath);
    if (stats.size > MAX_FILE_SIZE) {
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
      const error = `文件过大 (${sizeMB}MB > 20MB): ${path.basename(filePath)}`;
      logger?.warn?.({ path: filePath, size: stats.size }, "Media file too large");
      return { ok: false, error };
    }
  } catch (err) {
    const error = `无法读取文件: ${(err as Error)?.message}`;
    logger?.error?.(
      { path: filePath, err: { message: (err as Error)?.message } },
      "Failed to stat media file",
    );
    return { ok: false, error };
  }

  // 3. Upload to DingTalk
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = name ?? path.basename(filePath);
    const mediaType = detectMediaType(fileName);

    logger?.debug?.({ path: filePath, fileName, mediaType }, "Uploading media to DingTalk");

    // Use the robot messageFiles upload API for better filename support
    const uploadResult = await uploadMedia({
      account,
      file: fileBuffer,
      fileName,
      tokenManager,
      logger,
    });

    if (!uploadResult.ok || !uploadResult.mediaId) {
      // Fallback to OAPI upload
      logger?.debug?.({ path: filePath }, "Falling back to OAPI upload");
      const oapiResult = await uploadMediaToOAPI({
        account,
        media: fileBuffer,
        fileName,
        mediaType,
        tokenManager,
        logger,
      });

      if (!oapiResult.ok || !oapiResult.mediaId) {
        const error = `上传失败: ${oapiResult.error?.message ?? "未知错误"}`;
        logger?.error?.(
          { path: filePath, err: { message: oapiResult.error?.message } },
          "Failed to upload media",
        );
        return { ok: false, error };
      }

      return { ok: true, mediaId: oapiResult.mediaId, fileName };
    }

    return { ok: true, mediaId: uploadResult.mediaId, fileName };
  } catch (err) {
    const error = `处理失败: ${(err as Error)?.message}`;
    logger?.error?.(
      { path: filePath, err: { message: (err as Error)?.message } },
      "Media processing error",
    );
    return { ok: false, error };
  }
}

/**
 * Sends a single media item via sessionWebhook.
 *
 * The process is:
 * 1. Upload to DingTalk to get mediaId (using uploadMediaItem)
 * 2. Send appropriate message type via sessionWebhook
 */
export async function sendMediaItem(
  item: MediaItem,
  options: MediaSendOptions,
): Promise<SendMediaResult> {
  const { sessionWebhook, logger } = options;
  const { type } = item;

  // Adapt StreamLogger to ReplyLogger
  const replyLogger: ReplyLogger = {
    debug: logger?.debug,
    warn: logger?.warn,
    error: logger?.error,
  };

  const uploadResult = await uploadMediaItem(item, options);
  if (!uploadResult.ok || !uploadResult.mediaId) {
    return { ok: false, error: uploadResult.error };
  }

  return await sendMediaWithId(
    type,
    uploadResult.mediaId,
    uploadResult.fileName!,
    sessionWebhook,
    replyLogger,
  );
}

/**
 * Sends a media message given its mediaId.
 */
async function sendMediaWithId(
  type: MediaItem["type"],
  mediaId: string,
  fileName: string,
  sessionWebhook: string,
  logger?: ReplyLogger,
): Promise<SendMediaResult> {
  switch (type) {
    case "image":
      return await sendImageToWebhook(mediaId, sessionWebhook, logger);

    case "file":
      return await sendFileToWebhook(mediaId, fileName, sessionWebhook, logger);

    case "video":
      return await sendVideoToWebhook(mediaId, sessionWebhook, logger);

    case "audio":
      return await sendAudioToWebhook(mediaId, sessionWebhook, logger);
  }

  const unreachable: never = type;
  logger?.warn?.({ type: unreachable }, "Unknown media type");
  return { ok: false, error: "未知媒体类型" };
}

/**
 * Send image via sessionWebhook using mediaId.
 */
async function sendImageToWebhook(
  mediaId: string,
  sessionWebhook: string,
  logger?: ReplyLogger,
): Promise<SendMediaResult> {
  const result = await sendImageWithMediaIdViaSessionWebhook(sessionWebhook, mediaId, { logger });
  return {
    ok: result.ok,
    mediaId,
    error: result.ok ? undefined : (result.reason ?? "发送失败"),
  };
}

/**
 * Send file via sessionWebhook.
 * Note: DingTalk sessionWebhook supports 'file' msgtype.
 */
async function sendFileToWebhook(
  mediaId: string,
  fileName: string,
  sessionWebhook: string,
  logger?: ReplyLogger,
): Promise<SendMediaResult> {
  const payload = {
    msgtype: "file",
    file: {
      mediaId,
      fileName,
      fileType: path.extname(fileName).slice(1) || "file",
    },
  };

  try {
    const resp = await fetch(sessionWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const data = await resp.text();
      logger?.error?.(
        { err: { message: `HTTP ${resp.status}`, data: data.slice(0, 200) } },
        "Failed to send file to DingTalk",
      );
      return { ok: false, error: `HTTP ${resp.status}` };
    }

    logger?.debug?.({ mediaId, fileName }, "Sent file to DingTalk");
    return { ok: true, mediaId };
  } catch (err) {
    const error = (err as Error)?.message ?? "发送失败";
    logger?.error?.({ err: { message: error } }, "Failed to send file");
    return { ok: false, error };
  }
}

/**
 * Send video via sessionWebhook.
 * Note: DingTalk sessionWebhook supports 'video' msgtype.
 */
async function sendVideoToWebhook(
  mediaId: string,
  sessionWebhook: string,
  logger?: ReplyLogger,
): Promise<SendMediaResult> {
  const payload = {
    msgtype: "video",
    video: {
      videoMediaId: mediaId,
      videoType: "mp4",
    },
  };

  try {
    const resp = await fetch(sessionWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const data = await resp.text();
      logger?.error?.(
        { err: { message: `HTTP ${resp.status}`, data: data.slice(0, 200) } },
        "Failed to send video to DingTalk",
      );
      return { ok: false, error: `HTTP ${resp.status}` };
    }

    logger?.debug?.({ mediaId }, "Sent video to DingTalk");
    return { ok: true, mediaId };
  } catch (err) {
    const error = (err as Error)?.message ?? "发送失败";
    logger?.error?.({ err: { message: error } }, "Failed to send video");
    return { ok: false, error };
  }
}

/**
 * Send audio/voice via sessionWebhook.
 * Note: DingTalk sessionWebhook supports 'voice' msgtype.
 */
async function sendAudioToWebhook(
  mediaId: string,
  sessionWebhook: string,
  logger?: ReplyLogger,
): Promise<SendMediaResult> {
  const payload = {
    msgtype: "voice",
    voice: {
      mediaId,
      duration: "60000", // Default duration in ms
    },
  };

  try {
    const resp = await fetch(sessionWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const data = await resp.text();
      logger?.error?.(
        { err: { message: `HTTP ${resp.status}`, data: data.slice(0, 200) } },
        "Failed to send audio to DingTalk",
      );
      return { ok: false, error: `HTTP ${resp.status}` };
    }

    logger?.debug?.({ mediaId }, "Sent audio to DingTalk");
    return { ok: true, mediaId };
  } catch (err) {
    const error = (err as Error)?.message ?? "发送失败";
    logger?.error?.({ err: { message: error } }, "Failed to send audio");
    return { ok: false, error };
  }
}

/**
 * Process and send multiple media items.
 * Returns a summary of successes and failures.
 */
export async function processMediaItems(
  items: MediaItem[],
  options: MediaSendOptions,
): Promise<{
  successCount: number;
  failureCount: number;
  errors: string[];
}> {
  const { logger } = options;
  let successCount = 0;
  let failureCount = 0;
  const errors: string[] = [];

  logger?.debug?.({ count: items.length }, "Processing media items");

  for (const item of items) {
    const result = await sendMediaItem(item, options);

    if (result.ok) {
      successCount++;
      logger?.debug?.({ path: item.path, type: item.type }, "Media sent successfully");
    } else {
      failureCount++;
      const errorMsg = `${item.type}: ${result.error}`;
      errors.push(errorMsg);
      logger?.warn?.(
        { path: item.path, type: item.type, error: result.error },
        "Media send failed",
      );
    }
  }

  return { successCount, failureCount, errors };
}
