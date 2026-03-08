/**
 * 企业微信媒体（图片）下载和保存模块
 *
 * 负责下载、检测格式、保存图片到本地，包含超时保护
 */

import type { WSClient } from "@wecom/aibot-node-sdk";
import { fileTypeFromBuffer } from "file-type";
import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import {
  IMAGE_DOWNLOAD_TIMEOUT_MS,
  FILE_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_MEDIA_MAX_MB,
} from "./const.ts";
import { getWeComRuntime } from "./runtime.ts";
import { withTimeout } from "./timeout.ts";
import type { ResolvedWeComAccount } from "./utils.ts";

// ============================================================================
// 图片格式检测辅助函数（基于 file-type 包）
// ============================================================================

/**
 * 检查 Buffer 是否为有效的图片格式
 */
async function isImageBuffer(data: Buffer): Promise<boolean> {
  const type = await fileTypeFromBuffer(data);
  return type?.mime.startsWith("image/") ?? false;
}

/**
 * 检测 Buffer 的图片内容类型
 */
async function detectImageContentType(data: Buffer): Promise<string> {
  const type = await fileTypeFromBuffer(data);
  if (type?.mime.startsWith("image/")) {
    return type.mime;
  }
  return "application/octet-stream";
}

// ============================================================================
// 图片下载和保存
// ============================================================================

/**
 * 下载并保存所有图片到本地，每张图片的下载带超时保护
 */
export async function downloadAndSaveImages(params: {
  imageUrls: string[];
  imageAesKeys?: Map<string, string>;
  account: ResolvedWeComAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  wsClient: WSClient;
}): Promise<Array<{ path: string; contentType?: string }>> {
  const { imageUrls, config, runtime, wsClient } = params;
  const core = getWeComRuntime();
  const mediaList: Array<{ path: string; contentType?: string }> = [];

  for (const imageUrl of imageUrls) {
    try {
      runtime.log?.(`[WeCom] Downloading image from: ${imageUrl}`);
      const mediaMaxMb = config.agents?.defaults?.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
      const maxBytes = mediaMaxMb * 1024 * 1024;

      let imageBuffer: Buffer;
      let imageContentType: string;
      let originalFilename: string | undefined;
      const imageAesKey = params.imageAesKeys?.get(imageUrl);

      try {
        // 优先使用 SDK 的 downloadFile 方法下载（带超时保护）
        const result = await withTimeout(
          wsClient.downloadFile(imageUrl, imageAesKey),
          IMAGE_DOWNLOAD_TIMEOUT_MS,
          `Image download timed out: ${imageUrl}`,
        );
        imageBuffer = result.buffer;
        originalFilename = result.filename;
        imageContentType = await detectImageContentType(imageBuffer);
        runtime.log?.(
          `[WeCom] Image downloaded via SDK: size=${imageBuffer.length}, contentType=${imageContentType}${originalFilename ? `, filename=${originalFilename}` : ""}`,
        );
      } catch (sdkError) {
        // 如果 SDK 方法失败，回退到原有方式（带超时保护）
        runtime.log?.(
          `[WeCom] SDK download failed, falling back to manual download: ${String(sdkError)}`,
        );
        const fetched = (await withTimeout(
          core.channel.media.fetchRemoteMedia({ url: imageUrl }),
          IMAGE_DOWNLOAD_TIMEOUT_MS,
          `Manual image download timed out: ${imageUrl}`,
        )) as { buffer: Buffer; contentType?: string };
        runtime.log?.(
          `[WeCom] Image fetched: contentType=${fetched.contentType}, size=${fetched.buffer.length}, first4Bytes=${fetched.buffer.slice(0, 4).toString("hex")}`,
        );

        imageBuffer = fetched.buffer;
        imageContentType = fetched.contentType ?? "application/octet-stream";
        const isValidImage = await isImageBuffer(fetched.buffer);

        if (!isValidImage) {
          runtime.log?.(`[WeCom] WARN: Image does not appear to be a valid image format`);
        }
      }

      const saved = await core.channel.media.saveMediaBuffer(
        imageBuffer,
        imageContentType,
        "inbound",
        maxBytes,
        originalFilename,
      );
      mediaList.push({ path: saved.path, contentType: saved.contentType });
      runtime.log?.(`[WeCom] Image saved to ${saved.path}, finalContentType=${saved.contentType}`);
    } catch (err) {
      runtime.error?.(`[WeCom] Failed to download image: ${String(err)}`);
    }
  }

  return mediaList;
}

/**
 * 下载并保存所有文件到本地，每个文件的下载带超时保护
 */
export async function downloadAndSaveFiles(params: {
  fileUrls: string[];
  fileAesKeys?: Map<string, string>;
  account: ResolvedWeComAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  wsClient: WSClient;
}): Promise<Array<{ path: string; contentType?: string }>> {
  const { fileUrls, config, runtime, wsClient } = params;
  const core = getWeComRuntime();
  const mediaList: Array<{ path: string; contentType?: string }> = [];

  for (const fileUrl of fileUrls) {
    try {
      runtime.log?.(`[WeCom] Downloading file from: ${fileUrl}`);
      const mediaMaxMb = config.agents?.defaults?.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
      const maxBytes = mediaMaxMb * 1024 * 1024;

      let fileBuffer: Buffer;
      let fileContentType: string;
      let originalFilename: string | undefined;
      const fileAesKey = params.fileAesKeys?.get(fileUrl);

      try {
        // 使用 SDK 的 downloadFile 方法下载（带超时保护）
        const result = await withTimeout(
          wsClient.downloadFile(fileUrl, fileAesKey),
          FILE_DOWNLOAD_TIMEOUT_MS,
          `File download timed out: ${fileUrl}`,
        );
        fileBuffer = result.buffer;
        originalFilename = result.filename;

        // 检测文件类型
        const type = await fileTypeFromBuffer(fileBuffer);
        fileContentType = type?.mime ?? "application/octet-stream";
        runtime.log?.(
          `[WeCom] File downloaded via SDK: size=${fileBuffer.length}, contentType=${fileContentType}${originalFilename ? `, filename=${originalFilename}` : ""}`,
        );
      } catch (sdkError) {
        // 如果 SDK 方法失败，回退到 fetchRemoteMedia（带超时保护）
        runtime.log?.(
          `[WeCom] SDK file download failed, falling back to manual download: ${String(sdkError)}`,
        );
        const fetched = (await withTimeout(
          core.channel.media.fetchRemoteMedia({ url: fileUrl }),
          FILE_DOWNLOAD_TIMEOUT_MS,
          `Manual file download timed out: ${fileUrl}`,
        )) as { buffer: Buffer; contentType?: string };
        runtime.log?.(
          `[WeCom] File fetched: contentType=${fetched.contentType}, size=${fetched.buffer.length}`,
        );

        fileBuffer = fetched.buffer;
        fileContentType = fetched.contentType ?? "application/octet-stream";
      }

      const saved = await core.channel.media.saveMediaBuffer(
        fileBuffer,
        fileContentType,
        "inbound",
        maxBytes,
        originalFilename,
      );
      mediaList.push({ path: saved.path, contentType: saved.contentType });
      runtime.log?.(`[WeCom] File saved to ${saved.path}, finalContentType=${saved.contentType}`);
    } catch (err) {
      runtime.error?.(`[WeCom] Failed to download file: ${String(err)}`);
    }
  }

  return mediaList;
}
