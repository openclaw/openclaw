/**
 * WeCom media (image) download and save module
 *
 * Handles downloading, format detection, and saving images locally, with timeout protection
 */

import type { WSClient } from "@wecom/aibot-node-sdk";
import { fileTypeFromBuffer } from "file-type";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  IMAGE_DOWNLOAD_TIMEOUT_MS,
  FILE_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_MEDIA_MAX_MB,
} from "./const.js";
import { getWeComRuntime } from "./runtime.js";
import { withTimeout } from "./timeout.js";
import type { ResolvedWeComAccount } from "./utils.js";

// ============================================================================
// Image format detection helpers (based on the file-type package)
// ============================================================================

/**
 * Check whether a Buffer contains a valid image format
 */
async function isImageBuffer(data: Buffer): Promise<boolean> {
  const type = await fileTypeFromBuffer(data);
  return type?.mime.startsWith("image/") ?? false;
}

/**
 * Detect the image content type from a Buffer
 */
async function detectImageContentType(data: Buffer): Promise<string> {
  const type = await fileTypeFromBuffer(data);
  if (type?.mime.startsWith("image/")) {
    return type.mime;
  }
  return "application/octet-stream";
}

// ============================================================================
// Image download and save
// ============================================================================

/**
 * Download and save all images locally; each image download has timeout protection
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
      runtime.log?.(`[wecom] Downloading image: url=${imageUrl}`);
      const mediaMaxMb = config.agents?.defaults?.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
      const maxBytes = mediaMaxMb * 1024 * 1024;

      let imageBuffer: Buffer;
      let imageContentType: string;
      let originalFilename: string | undefined;
      const imageAesKey = params.imageAesKeys?.get(imageUrl);

      try {
        // Prefer SDK's downloadFile method (with timeout protection)
        const result = await withTimeout(
          wsClient.downloadFile(imageUrl, imageAesKey),
          IMAGE_DOWNLOAD_TIMEOUT_MS,
          `Image download timed out: ${imageUrl}`,
        );
        imageBuffer = result.buffer;
        originalFilename = result.filename;
        imageContentType = await detectImageContentType(imageBuffer);
        runtime.log?.(
          `[wecom] Image downloaded: size=${imageBuffer.length}, contentType=${imageContentType}, filename=${originalFilename ?? "(none)"}`,
        );
      } catch (sdkError) {
        // If the message is encrypted (per-message aeskey present), bail
        // out instead of falling back: `fetchRemoteMedia` can't decrypt
        // the WeCom ciphertext, so saving the raw bytes would produce a
        // corrupted attachment exactly in the failure mode this fallback
        // is meant to handle. The outer catch will log and skip this
        // image.
        if (imageAesKey) {
          runtime.error?.(
            `[wecom] SDK image download failed for encrypted media (aeskey present); ` +
              `not falling back to raw fetch to avoid persisting ciphertext: ${String(sdkError)}`,
          );
          throw sdkError;
        }

        // Non-encrypted media: fall back to fetchRemoteMedia (with timeout protection)
        runtime.log?.(`[wecom] SDK download failed, fallback: ${String(sdkError)}`);
        const fetched = (await withTimeout(
          core.channel.media.fetchRemoteMedia({ url: imageUrl }),
          IMAGE_DOWNLOAD_TIMEOUT_MS,
          `Manual image download timed out: ${imageUrl}`,
        )) as { buffer: Buffer; contentType?: string };
        runtime.log?.(
          `[wecom] Image fetched: contentType=${fetched.contentType}, size=${fetched.buffer.length}`,
        );

        imageBuffer = fetched.buffer;
        imageContentType = fetched.contentType ?? "application/octet-stream";
        const isValidImage = await isImageBuffer(fetched.buffer);

        if (!isValidImage) {
          runtime.log?.(`[wecom] WARN: Downloaded data is not a valid image format`);
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
      runtime.log?.(
        `[wecom][plugin] Image saved: path=${saved.path}, contentType=${saved.contentType}`,
      );
    } catch (err) {
      runtime.error?.(`[wecom] Failed to download image: ${String(err)}`);
    }
  }

  return mediaList;
}

/**
 * Download and save all files locally; each file download has timeout protection
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
      runtime.log?.(`[wecom] Downloading file: url=${fileUrl}`);
      const mediaMaxMb = config.agents?.defaults?.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
      const maxBytes = mediaMaxMb * 1024 * 1024;

      let fileBuffer: Buffer;
      let fileContentType: string;
      let originalFilename: string | undefined;
      const fileAesKey = params.fileAesKeys?.get(fileUrl);

      try {
        // Use SDK's downloadFile method (with timeout protection)
        const result = await withTimeout(
          wsClient.downloadFile(fileUrl, fileAesKey),
          FILE_DOWNLOAD_TIMEOUT_MS,
          `File download timed out: ${fileUrl}`,
        );
        fileBuffer = result.buffer;
        originalFilename = result.filename;

        // Detect file type
        const type = await fileTypeFromBuffer(fileBuffer);
        fileContentType = type?.mime ?? "application/octet-stream";
        runtime.log?.(
          `[wecom] File downloaded: size=${fileBuffer.length}, contentType=${fileContentType}, filename=${originalFilename ?? "(none)"}`,
        );
      } catch (sdkError) {
        // Same guard as in downloadAndSaveImages: if the message is
        // encrypted (per-message aeskey present), don't fall back to the
        // plain fetch path — it can't decrypt WeCom ciphertext and would
        // persist corrupted bytes. The outer catch will log and skip.
        if (fileAesKey) {
          runtime.error?.(
            `[wecom] SDK file download failed for encrypted media (aeskey present); ` +
              `not falling back to raw fetch to avoid persisting ciphertext: ${String(sdkError)}`,
          );
          throw sdkError;
        }

        // Non-encrypted media: fall back to fetchRemoteMedia (with timeout protection)
        runtime.log?.(`[wecom] SDK file download failed, fallback: ${String(sdkError)}`);
        const fetched = (await withTimeout(
          core.channel.media.fetchRemoteMedia({ url: fileUrl }),
          FILE_DOWNLOAD_TIMEOUT_MS,
          `Manual file download timed out: ${fileUrl}`,
        )) as { buffer: Buffer; contentType?: string };
        runtime.log?.(
          `[wecom] File fetched: contentType=${fetched.contentType}, size=${fetched.buffer.length}`,
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
      runtime.log?.(
        `[wecom][plugin] File saved: path=${saved.path}, contentType=${saved.contentType}`,
      );
    } catch (err) {
      runtime.error?.(`[wecom] Failed to download file: ${String(err)}`);
    }
  }

  return mediaList;
}
