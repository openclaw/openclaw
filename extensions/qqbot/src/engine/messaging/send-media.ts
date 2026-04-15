/**
 * Unified media upload + send — route media to the correct QQ target type.
 *
 * Replaces the 8 pairs of `sendC2CImageMessage`/`sendGroupImageMessage` etc.
 * with a single `uploadAndSendMedia` function that accepts a `ChatScope`.
 *
 * This module only depends on `core/api/` and `core/types.ts`.
 * It does NOT import any `src/` root files.
 */

import type { MediaApi } from "../api/media.js";
import type { Credentials } from "../api/messages.js";
import type { ChatScope, MediaFileType, UploadMediaResponse, OutboundMeta } from "../types.js";
import { IMAGE_MIME_TYPES, getCleanExtension } from "./media-type-detect.js";

/** Options for uploading and sending a media message. */
export interface MediaSendOptions {
  /** C2C / group scope. */
  scope: ChatScope;
  /** Target openid (C2C) or group openid. */
  targetId: string;
  /** Media file type code. */
  fileType: MediaFileType;
  /** API credentials. */
  creds: Credentials;
  /** Remote URL to upload. Mutually exclusive with fileData. */
  url?: string;
  /** Base64-encoded file data. Mutually exclusive with url. */
  fileData?: string;
  /** Inbound message ID for passive reply. */
  msgId?: string;
  /** Text content to attach alongside the media. */
  content?: string;
  /** File name for FILE type uploads. */
  fileName?: string;
  /** Outbound metadata for refIdx hook. */
  meta?: OutboundMeta;
}

/** Result of a media send operation. */
export interface MediaSendResult {
  /** Upload response (file_info, file_uuid, ttl). */
  upload: UploadMediaResponse;
  /** Message send response (id, timestamp). */
  message: { id: string; timestamp: string | number };
}

/**
 * Upload media and send it as a message in one step.
 *
 * Combines `mediaApi.uploadMedia()` + `mediaApi.sendMediaMessage()` into
 * a single call, replacing the old 8-pair C2C/Group convenience functions.
 *
 * @param mediaApi - Core MediaApi instance.
 * @param opts - Upload and send options.
 * @returns Upload and message send results.
 */
export async function uploadAndSendMedia(
  mediaApi: MediaApi,
  opts: MediaSendOptions,
): Promise<MediaSendResult> {
  const upload = await mediaApi.uploadMedia(opts.scope, opts.targetId, opts.fileType, opts.creds, {
    url: opts.url,
    fileData: opts.fileData,
    srvSendMsg: false,
    fileName: opts.fileName,
  });

  const message = await mediaApi.sendMediaMessage(
    opts.scope,
    opts.targetId,
    upload.file_info,
    opts.creds,
    {
      msgId: opts.msgId,
      content: opts.content,
    },
  );

  return { upload, message };
}

/**
 * Convert a Base64 data URL to raw base64 data and MIME type.
 *
 * @returns `{ mimeType, base64Data }` or `null` if the URL is not a valid data URL.
 */
export function parseBase64DataUrl(
  dataUrl: string,
): { mimeType: string; base64Data: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    return null;
  }
  return { mimeType: match[1], base64Data: match[2] };
}

/**
 * Convert a local file buffer to a Base64 image data URL.
 *
 * @param buffer - File contents.
 * @param filePath - File path for extension-based MIME detection.
 * @returns Base64 data URL string, or null if the extension is unsupported.
 */
export function bufferToImageDataUrl(buffer: Buffer, filePath: string): string | null {
  const ext = getCleanExtension(filePath);
  const mimeType = IMAGE_MIME_TYPES[ext];
  if (!mimeType) {
    return null;
  }
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}
