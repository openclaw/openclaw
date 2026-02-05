/**
 * DingTalk Media Upload API for local files.
 * Uses the OAPI media upload endpoint to get mediaId for local files.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolvedDingTalkAccount } from "../accounts.js";
import type { StreamLogger } from "../stream/types.js";
import { createTokenManagerFromAccount, type TokenManager } from "./token-manager.js";

/**
 * DingTalk OAPI base URL for media upload.
 * This is different from the new API (api.dingtalk.com) used for other operations.
 */
const DINGTALK_OAPI_BASE = "https://oapi.dingtalk.com";

/**
 * Media type for DingTalk upload API.
 */
export type MediaType = "image" | "voice" | "video" | "file";

/**
 * Result of uploading media to OAPI.
 */
export interface UploadMediaResult {
  ok: boolean;
  mediaId?: string;
  type?: MediaType;
  error?: Error;
}

/**
 * Image file extensions.
 */
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"]);

/**
 * Voice file extensions.
 */
const VOICE_EXTENSIONS = new Set([".mp3", ".wav", ".amr", ".opus", ".ogg"]);

/**
 * Video file extensions.
 */
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm"]);

/**
 * Detect media type based on file extension.
 */
export function detectMediaType(fileName: string): MediaType {
  const ext = path.extname(fileName).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) {
    return "image";
  }
  if (VOICE_EXTENSIONS.has(ext)) {
    return "voice";
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return "video";
  }
  return "file";
}

/**
 * Check if a string is a local file path (not a URL).
 *
 * Local path patterns:
 * - Absolute paths: /tmp/foo.png, /Users/xxx/image.jpg
 * - Windows paths: C:\Users\xxx\image.jpg
 * - Home paths: ~/Downloads/image.png
 * - file:// protocol: file:///tmp/foo.png
 * - MEDIA: prefix: MEDIA:/tmp/foo.png
 * - attachment:// prefix: attachment:///tmp/foo.png
 */
export function isLocalPath(urlOrPath: string): boolean {
  if (!urlOrPath || typeof urlOrPath !== "string") {
    return false;
  }

  const trimmed = urlOrPath.trim();

  // Check for special local path prefixes
  if (
    trimmed.startsWith("file://") ||
    trimmed.startsWith("MEDIA:") ||
    trimmed.startsWith("attachment://")
  ) {
    return true;
  }

  // Check for Unix absolute paths
  if (trimmed.startsWith("/")) {
    return true;
  }

  // Check for home directory paths
  if (trimmed.startsWith("~")) {
    return true;
  }

  // Check for Windows absolute paths (C:\ or D:\)
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return true;
  }

  // Check if it's a valid URL (http://, https://, etc.)
  try {
    const url = new URL(trimmed);
    // If it parses as a URL with http/https, it's not a local path
    return url.protocol === "file:";
  } catch {
    // If it doesn't parse as a URL, it might be a relative path
    // For safety, we treat unrecognized patterns as non-local
    return false;
  }
}

/**
 * Normalize a local path by removing special prefixes.
 */
export function normalizeLocalPath(rawPath: string): string {
  let p = rawPath.trim();

  // Remove special prefixes
  if (p.startsWith("file://")) {
    p = p.slice(7);
  } else if (p.startsWith("MEDIA:")) {
    p = p.slice(6);
  } else if (p.startsWith("attachment://")) {
    p = p.slice(13);
  }

  // Handle URL encoding
  try {
    p = decodeURIComponent(p);
  } catch {
    // Ignore decoding errors
  }

  // Expand home directory
  if (p.startsWith("~")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    p = path.join(home, p.slice(1));
  }

  return p;
}

/**
 * Upload media to DingTalk OAPI and get mediaId.
 *
 * This uses the old OAPI endpoint (oapi.dingtalk.com/media/upload) which
 * returns a media_id that can be used with sessionWebhook image messages.
 *
 * API: POST https://oapi.dingtalk.com/media/upload?access_token=xxx&type=image
 */
export async function uploadMediaToOAPI(opts: {
  account: ResolvedDingTalkAccount;
  media: Buffer;
  fileName: string;
  mediaType?: MediaType;
  tokenManager?: TokenManager;
  logger?: StreamLogger;
}): Promise<UploadMediaResult> {
  const {
    account,
    media,
    fileName,
    mediaType = detectMediaType(fileName),
    tokenManager: providedTokenManager,
    logger,
  } = opts;

  const tokenManager = providedTokenManager ?? createTokenManagerFromAccount(account, logger);

  let accessToken: string;
  try {
    accessToken = await tokenManager.getToken();
  } catch (err) {
    logger?.error?.(
      { err: { message: (err as Error)?.message } },
      "Failed to get access token for OAPI media upload"
    );
    return { ok: false, error: err as Error };
  }

  const url = `${DINGTALK_OAPI_BASE}/media/upload?access_token=${accessToken}&type=${mediaType}`;

  try {
    // Create FormData for file upload
    const formData = new FormData();
    const blob = new Blob([media], { type: "application/octet-stream" });
    formData.append("media", blob, fileName);

    logger?.debug?.(
      { fileName, mediaType, size: media.length },
      "Uploading media to OAPI"
    );

    const resp = await fetch(url, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(60_000), // 60s timeout for file upload
    });

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "");
      logger?.error?.(
        { status: resp.status, error: errorText.slice(0, 200), fileName },
        "OAPI media upload failed (HTTP error)"
      );
      return {
        ok: false,
        error: new Error(`HTTP ${resp.status}: ${errorText.slice(0, 200)}`),
      };
    }

    const data = (await resp.json()) as {
      errcode?: number;
      errmsg?: string;
      media_id?: string;
      type?: string;
    };

    // Check for API-level errors
    if (data.errcode && data.errcode !== 0) {
      logger?.error?.(
        { errcode: data.errcode, errmsg: data.errmsg, fileName },
        "OAPI media upload failed (API error)"
      );
      return {
        ok: false,
        error: new Error(`DingTalk API error: ${data.errmsg} (code: ${data.errcode})`),
      };
    }

    if (!data.media_id) {
      logger?.error?.({ data, fileName }, "OAPI media upload failed (no media_id)");
      return {
        ok: false,
        error: new Error("DingTalk API returned no media_id"),
      };
    }

    logger?.debug?.(
      { mediaId: data.media_id, type: data.type, fileName },
      "OAPI media uploaded successfully"
    );

    return {
      ok: true,
      mediaId: data.media_id,
      type: (data.type as MediaType) ?? mediaType,
    };
  } catch (err) {
    logger?.error?.(
      { err: { message: (err as Error)?.message }, fileName },
      "OAPI media upload error"
    );
    return { ok: false, error: err as Error };
  }
}

/**
 * Upload a local file to DingTalk OAPI.
 * Reads the file from disk and uploads it.
 */
export async function uploadLocalFile(opts: {
  account: ResolvedDingTalkAccount;
  filePath: string;
  tokenManager?: TokenManager;
  logger?: StreamLogger;
}): Promise<UploadMediaResult> {
  const { account, filePath, tokenManager, logger } = opts;

  // Normalize the path
  const normalizedPath = normalizeLocalPath(filePath);

  // Check if file exists
  if (!fs.existsSync(normalizedPath)) {
    logger?.error?.({ filePath: normalizedPath }, "Local file not found");
    return {
      ok: false,
      error: new Error(`File not found: ${normalizedPath}`),
    };
  }

  // Read the file
  const fileBuffer = fs.readFileSync(normalizedPath);
  const fileName = path.basename(normalizedPath);

  return uploadMediaToOAPI({
    account,
    media: fileBuffer,
    fileName,
    tokenManager,
    logger,
  });
}

/**
 * Check if a URL points to an image based on extension.
 */
export function isImageUrl(url: string): boolean {
  if (!url || typeof url !== "string") {
    return false;
  }

  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  } catch {
    // If URL parsing fails, try direct extension check
    const ext = path.extname(url.split("?")[0] ?? "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  }
}
