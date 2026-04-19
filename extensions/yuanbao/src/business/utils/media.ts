/**
 * Media file processing module.
 *
 * Supports image/file upload and download in the plugin environment.
 * - Upload: calls Yuanbao API for COS pre-signed config, then uploads via cos-js-sdk-v5
 * - Download: supports downloading from URL/local path to Buffer
 *
 * Note: runs in Node.js ESM environment, no browser API dependencies.
 */

import { randomBytes, createHash } from "node:crypto";
import { createReadStream, statSync, existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path, { basename, extname, join } from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { apiGetDownloadUrl, apiGetUploadInfo } from "../../access/api.js";
import type { CosUploadConfig } from "../../access/api.js";
import type { ResolvedYuanbaoAccount } from "../../types.js";

/** Upload result */
export type MediaUploadResult = {
  /** Public URL */
  url: string;
  /** Filename */
  filename: string;
  /** File size (bytes) */
  size: number;
  /** MIME type */
  mimeType: string;
  /** File content MD5 (hex), usable as image UUID */
  uuid: string;
  /** Image dimensions (only for image types) */
  imageInfo?: { width: number; height: number };
  /** Resource ID (if returned by server) */
  resourceId?: string;
};

/** Media file descriptor */
export type MediaFile = {
  /** Original filename (with extension) */
  filename: string;
  /** File content (Buffer) */
  data: Buffer;
  /** MIME type, e.g. image/jpeg, application/pdf */
  mimeType: string;
};

const DEFAULT_MAX_MB = 20;

/** Image extension set (lowercase) */
export const IMAGE_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".heic",
  ".tiff",
  ".ico",
]);

/**
 * Guess MIME type from filename.
 */
export function guessMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  const mime: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".heic": "image/heic",
    ".tiff": "image/tiff",
    ".ico": "image/x-icon",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".txt": "text/plain",
    ".zip": "application/zip",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".webm": "video/webm",
  };
  return mime[ext] ?? "application/octet-stream";
}

/**
 * Check if file is an image type (by MIME or extension).
 */
function isImage(filename: string, mimeType?: string): boolean {
  if (mimeType?.startsWith("image/")) {
    return true;
  }
  return IMAGE_EXTS.has(extname(filename).toLowerCase());
}

/**
 * Generate a random file ID.
 */
function generateFileId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Compute MD5 hash of a Buffer, returning hex string.
 */
function md5Hex(buffer: Buffer): string {
  return createHash("md5").update(buffer).digest("hex");
}

/**
 * Parse image dimensions from Buffer (supports JPEG/PNG/GIF/WebP), no extra dependencies.
 * Tries each format's magic number in order; returns undefined if none match.
 */
export function parseImageSize(buf: Buffer): { width: number; height: number } | undefined {
  return parsePngSize(buf) ?? parseJpegSize(buf) ?? parseGifSize(buf) ?? parseWebpSize(buf);
}

function parsePngSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 24) {
    return undefined;
  }
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    return undefined;
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function parseJpegSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return undefined;
  }
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xc0 || marker === 0xc2) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (i + 3 < buf.length) {
      i += 2 + buf.readUInt16BE(i + 2);
    } else {
      break;
    }
  }
  return undefined;
}

function parseGifSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 10) {
    return undefined;
  }
  const sig = buf.toString("ascii", 0, 6);
  if (sig !== "GIF87a" && sig !== "GIF89a") {
    return undefined;
  }
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function parseWebpSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 16) {
    return undefined;
  }
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") {
    return undefined;
  }
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8 ") {
    if (buf.length >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
  }
  if (chunk === "VP8L") {
    if (buf.length >= 25 && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  if (chunk === "VP8X") {
    if (buf.length >= 30) {
      return {
        width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1,
        height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1,
      };
    }
  }
  return undefined;
}

/**
 * Check if a string is a local file path (not a remote URL).
 */
function isLocalPath(s: string): boolean {
  return (
    s.startsWith("file://") ||
    s === "~" ||
    s.startsWith("~/") ||
    s.startsWith("~\\") ||
    s.startsWith("/") ||
    /^[a-zA-Z]:[/\\]/.test(s) ||
    s.startsWith("\\\\") ||
    s.startsWith("./") ||
    s.startsWith("../") ||
    s.startsWith(".\\") ||
    s.startsWith("..\\") ||
    !s.includes("://") // No scheme -> local path (bare filename / bare relative path)
  );
}

/**
 * Normalize local path:
 * 1. Trim whitespace
 * 2. Strip `file://` prefix and URI decode
 * 3. Expand tilde (`~`) to real home directory
 * 4. Resolve relative paths to absolute
 */
function normalizePath(s: string): string {
  let p = s.trim();
  if (p.startsWith("file://")) {
    try {
      p = decodeURIComponent(new URL(p).pathname);
    } catch {
      p = p.slice("file://".length);
    }
  }
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    p = homedir() + p.slice(1);
  }
  if (!path.isAbsolute(p)) {
    p = path.resolve(p);
  }
  return p;
}

/** Map content-type to file extension */
const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
};

/**
 * Extract filename from content-disposition header.
 * Supports both `filename=` and `filename*=UTF-8''` formats.
 */
function extractFilenameFromContentDisposition(contentDisp: string): string {
  const match = contentDisp.match(/filename\*?=(?:UTF-8'')?["']?([^;"'\r\n]+)/i);
  if (!match) {
    return "";
  }
  return decodeURIComponent(match[1].replace(/"/g, "")).trim();
}

/**
 * Infer filename from HTTP response (fallback logic; callers should prefer message metadata).
 * Priority: content-disposition > URL path > random hex + extension
 */function inferFilenameFromResponse(
  response: Response,
  fetchUrl: string,
  contentType: string,
): string {
  // 1. content-disposition
  const fromDisp = extractFilenameFromContentDisposition(
    response.headers.get("content-disposition") ?? "",
  );
  if (fromDisp) {
    return fromDisp;
  }

  // 2. URL path last segment
  const fromPath = basename(new URL(fetchUrl).pathname).trim();
  if (fromPath) {
    // No extension: supplement from content-type
    const inferredExt =
      MIME_TO_EXT[contentType] ??
      (contentType.startsWith("image/") ? `.${contentType.split("/")[1]}` : "");
    return extname(fromPath) ? fromPath : `${fromPath}${inferredExt}`;
  }

  // 3. Random fallback
  const inferredExt = MIME_TO_EXT[contentType] ?? "";
  return `${randomBytes(8).toString("hex")}${inferredExt}`;
}

/**
 * Resolve actual download URL: if it contains a resourceId param, exchange for real download URL via Yuanbao API.
 */
async function resolveFetchUrl(url: string, account?: ResolvedYuanbaoAccount): Promise<string> {
  const parsed = new URL(url);
  const resourceId = parsed.searchParams.get("resourceId");
  if (resourceId && account) {
    return apiGetDownloadUrl(account, resourceId);
  }
  return url;
}

/**
 * Download file from URL to Buffer.
 *
 * Supports two sources:
 * - `file://` or absolute path — local file, read directly
 * - `http(s)://` — remote URL, auto-resolves Yuanbao download URL if `resourceId` param present
 *
 * Note: returned `filename` is a fallback; callers should prefer `mediaName` from message metadata.
 */
export async function downloadMediaForYuanbao(
  url: string,
  maxMb = DEFAULT_MAX_MB,
  account?: ResolvedYuanbaoAccount,
): Promise<MediaFile> {
  const maxBytes = maxMb * 1024 * 1024;

  // Local file (file://, absolute path, tilde path, relative path, etc.)
  if (isLocalPath(url)) {
    const filePath = normalizePath(url);
    const stat = statSync(filePath);
    if (stat.size > maxBytes) {
      throw new Error(`文件过大: ${(stat.size / 1024 / 1024).toFixed(1)} MB > ${maxMb} MB`);
    }
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath);
      stream.on("data", (chunk) =>
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
      );
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    const data = Buffer.concat(chunks);
    const filename = basename(filePath);
    return { filename, data, mimeType: guessMimeType(filename) };
  }

  // Remote URL
  const fetchUrl = await resolveFetchUrl(url, account);
  const response = await fetch(fetchUrl);
  if (!response.ok) {
    throw new Error(`下载失败: HTTP ${response.status} ${response.statusText} — ${fetchUrl}`);
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > 0 && contentLength > maxBytes) {
    throw new Error(`文件过大: ${(contentLength / 1024 / 1024).toFixed(1)} MB > ${maxMb} MB`);
  }

  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > maxBytes) {
    throw new Error(`文件过大: ${(data.length / 1024 / 1024).toFixed(1)} MB > ${maxMb} MB`);
  }

  const contentType = response.headers.get("content-type")?.split(";")[0].trim() ?? "";
  const filename = inferFilenameFromResponse(response, fetchUrl, contentType);
  const mimeType = contentType || guessMimeType(filename);

  return { filename, data, mimeType };
}

/**
 * Download media via OpenClaw SDK and convert to MediaFile.
 * Unlike {@link downloadMediaForYuanbao}, this relies on core.media.loadWebMedia
 * for local path resolution and size limits, suitable for localRoots sandbox scenarios.
 */
async function downloadMediaForLocal(
  url: string,
  core: PluginRuntime,
  mediaLocalRoots?: string[],
  account?: ResolvedYuanbaoAccount,
): Promise<MediaFile> {
  if (!account) {
    throw new Error("account is required");
  }

  try {
    const loaded = await core.media.loadWebMedia(url, {
      maxBytes: account.mediaMaxMb * 1024 * 1024,
      optimizeImages: false,
      localRoots: mediaLocalRoots?.length ? mediaLocalRoots : undefined,
    });

    const { buffer } = loaded;
    const name = loaded.fileName ?? "file";
    return { filename: name, data: buffer, mimeType: guessMimeType(name) };
  } catch {
    // loadWebMedia failed, fall through to downloadMediaForYuanbao
  }

  // Fallback: downloadMediaForYuanbao supports HTTP URLs and local paths (including file://, absolute, tilde),
  // and validates file size before reading.
  return downloadMediaForYuanbao(url, account.mediaMaxMb, account);
}

/**
 * Minimal COS upload implementation (Node.js Buffer, no browser API dependencies).
 * Reuses cos-js-sdk-v5 SDK with params matching Yuanbao Web client.
 */
async function uploadBufferToCos(params: {
  config: CosUploadConfig;
  data: Buffer;
  filename: string;
  mimeType: string;
  onProgress?: (percent: number) => void;
}): Promise<string> {
  const { config, data, filename, mimeType } = params;

  // Dynamic import to avoid errors when SDK is not installed
  // cos-nodejs-sdk-v5 uses CommonJS export = syntax, needs compat handling
  let COS: unknown;
  try {
    // Prefer require (Node.js CJS compat path)
    COS = require("cos-nodejs-sdk-v5");
    if ((COS as Record<string, unknown>)?.default) {
      COS = (COS as Record<string, unknown>).default;
    }
  } catch {
    // CJS require failed, try ESM import
    try {
      const pkg = await import("cos-nodejs-sdk-v5" as string);
      COS = pkg.default ?? pkg;
    } catch {
      // Both CJS and ESM failed, throw clear error
      throw new Error("缺少依赖 cos-nodejs-sdk-v5，请运行 pnpm add cos-nodejs-sdk-v5");
    }
  }

  const COSConstructor = COS as new (opts: Record<string, unknown>) => { putObject: (params: Record<string, unknown>) => Promise<unknown> };
  const cos = new COSConstructor({
    FileParallelLimit: 10,
    getAuthorization(_: unknown, callback: (cred: object) => void) {
      callback({
        TmpSecretId: config.encryptTmpSecretId,
        TmpSecretKey: config.encryptTmpSecretKey,
        SecurityToken: config.encryptToken,
        StartTime: config.startTime,
        ExpiredTime: config.expiredTime,
        ScopeLimit: true,
      });
    },
    UseAccelerate: true,
  });

  // Construct request headers
  const headers: Record<string, string> = {};
  if (isImage(filename, mimeType)) {
    headers["Content-Type"] = mimeType || `image/${extname(filename).slice(1)}`;
    headers["Pic-Operations"] = JSON.stringify({
      is_pic_info: 1,
      rules: [{ fileid: config.location, rule: "imageMogr2/format/jpg" }],
    });
  } else {
    headers["Content-Type"] = "application/octet-stream";
  }

  await cos.putObject({
    Bucket: config.bucketName,
    Region: config.region,
    Key: config.location,
    Body: data,
    Headers: headers,
    onProgress: params.onProgress
      ? (progressData: { percent: number }) => {
          params.onProgress!(Math.round(progressData.percent * 10000) / 100);
        }
      : undefined,
  });

  return config.resourceUrl;
}

/**
 * Upload Buffer to COS (auto-fetches pre-signed config via api.ts).
 */
export async function uploadMediaToCos(
  mediaFile: MediaFile,
  account: ResolvedYuanbaoAccount,
  onProgress?: (percent: number) => void,
): Promise<MediaUploadResult> {
  const { filename, data, mimeType } = mediaFile;
  const maxBytes = account.mediaMaxMb * 1024 * 1024;

  if (data.length > maxBytes) {
    throw new Error(
      `文件过大: ${(data.length / 1024 / 1024).toFixed(1)} MB > ${account.mediaMaxMb} MB`,
    );
  }

  const fileId = generateFileId();
  const uuid = md5Hex(data);
  const imageInfo = mimeType.startsWith("image/") ? parseImageSize(data) : undefined;

  // 1. Get COS pre-signed config (with auth headers)
  const cosConfig = await apiGetUploadInfo(account, filename, fileId);

  // 2. Upload to COS
  const url = await uploadBufferToCos({ config: cosConfig, data, filename, mimeType, onProgress });

  return {
    url,
    filename,
    size: data.length,
    mimeType,
    uuid,
    imageInfo,
    resourceId: cosConfig.resourceID,
  };
}

/**
 * Download from URL/local path/resourceId and upload to COS (one-stop).
 */
export async function downloadAndUploadMedia(
  mediaUrl: string,
  core: PluginRuntime,
  account: ResolvedYuanbaoAccount,
  mediaLocalRoots?: string[],
  onProgress?: (percent: number) => void,
): Promise<MediaUploadResult> {
  const mediaFile = await downloadMediaForLocal(mediaUrl, core, mediaLocalRoots, account);
  return uploadMediaToCos(mediaFile, account, onProgress);
}

/**
 * Build Tencent IM TIMImageElem message body.
 * Ref: https://cloud.tencent.com/document/product/269/2720
 */
export function buildImageMsgBody(params: {
  url: string;
  filename?: string;
  size?: number;
  uuid?: string;
  imageInfo?: { width: number; height: number };
}): Array<{ msg_type: string; msg_content: Record<string, unknown> }> {
  return [
    {
      msg_type: "TIMImageElem",
      msg_content: {
        uuid: params.uuid ?? params.filename ?? basename(new URL(params.url).pathname) ?? "image",
        image_format: 255,
        image_info_array: [
          {
            type: 1,
            size: params.size ?? 0,
            width: params.imageInfo?.width ?? 0,
            height: params.imageInfo?.height ?? 0,
            url: params.url,
          },
        ],
      },
    },
  ];
}

/**
 * Build Tencent IM TIMFileElem message body.
 * Ref: https://cloud.tencent.com/document/product/269/2720
 */
export function buildFileMsgBody(params: {
  url: string;
  filename: string;
  size?: number;
  uuid?: string;
}): Array<{ msg_type: string; msg_content: Record<string, unknown> }> {
  return [
    {
      msg_type: "TIMFileElem",
      msg_content: {
        uuid: params.uuid ?? params.filename,
        file_name: params.filename,
        file_size: params.size ?? 0,
        url: params.url,
      },
    },
  ];
}

/**
 * Download media list and save to agent-accessible directory, returning local file paths.
 * - MIME type from HTTP response header first, fallback to core.media.detectMime
 * - Filename from mediaName first, then inferred from response/URL
 * - Failed downloads are skipped with warning log
 */
export async function downloadMediasToLocalFiles(
  medias: Array<{ url: string; mediaName?: string }>,
  account: ResolvedYuanbaoAccount,
  core: PluginRuntime,
  log: { verbose: (msg: string) => void; warn: (msg: string) => void },
): Promise<{
  results: Array<{ path: string; contentType: string }>;
  mediaPaths: string[];
  mediaTypes: string[];
}> {
  if (medias.length === 0) {
    return { results: [], mediaPaths: [], mediaTypes: [] };
  }

  const maxBytes = account.mediaMaxMb * 1024 * 1024;
  const cacheDir = join(resolvePreferredOpenClawTmpDir(), "yuanbao-media");

  // Download up to 20 media files concurrently
  const tasks = medias.slice(0, 20).map(async ({ url, mediaName }, i) => {
    const mediaFile = await downloadMediaForYuanbao(url, account.mediaMaxMb, account);

    const originalFilename = mediaName || mediaFile.filename;
    const ext = extname(originalFilename).toLowerCase();
    const md5 = md5Hex(mediaFile.data);
    const md5Filename = ext ? `${md5}${ext}` : md5;

    let contentType = mediaFile.mimeType;
    if (
      (!contentType || contentType === "application/octet-stream") &&
      typeof core.media?.detectMime === "function"
    ) {
      contentType = (await core.media.detectMime({ buffer: mediaFile.data })) ?? contentType;
    }

    const cachedFilePath = join(cacheDir, md5Filename);
    if (existsSync(cachedFilePath)) {
      log.verbose(
        `media ${i + 1}/${medias.length} hit local cache, skipping save: ${cachedFilePath}`,
      );
      return { path: cachedFilePath, contentType };
    }

    if (typeof core.channel.media?.saveMediaBuffer === "function") {
      const saved = await core.channel.media.saveMediaBuffer(
        mediaFile.data,
        contentType,
        "inbound",
        maxBytes,
        md5Filename,
      );
      return { path: saved.path, contentType: saved.contentType ?? contentType };
    }

    await mkdir(cacheDir, { recursive: true });
    await writeFile(cachedFilePath, mediaFile.data);
    return { path: cachedFilePath, contentType };
  });
  const settled = await Promise.allSettled(tasks);

  const results: Array<{ path: string; contentType: string }> = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "fulfilled") {
      results.push(r.value);
      log.verbose(
        `media ${i + 1}/${medias.length} download complete: ${r.value.path} (${r.value.contentType})`,
      );
    } else {
      log.warn(`media ${i + 1}/${medias.length} download failed, skipping: ${String(r.reason)}`);
    }
  }
  return {
    results,
    mediaPaths: results.map((r) => r.path),
    mediaTypes: results.map((r) => r.contentType),
  };
}
