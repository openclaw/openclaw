/**
 * Media file processing module
 *
 * 支持Image/文件在插件环境的上传/下载。
 * - 上传：调用元宝 API 获取 COS 预签配置，再通过 cos-js-sdk-v5 上传
 * - 下载：支持从 URL/本地路径下载为 Buffer
 *
 * Note:此模块运行在 Node.js ESM 环境，不依赖浏览器 API（Blob/File/localStorage 等）。
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

// ============ 类型定义 ============

/** 上传结果 */
export type MediaUploadResult = {
  /** 资源公网 URL */
  url: string;
  /** 文件名 */
  filename: string;
  /** File size (bytes) */
  size: number;
  /** MIME 类型 */
  mimeType: string;
  /** 文件内容 MD5（hex），可用作Image UUID */
  uuid: string;
  /** Image尺寸（仅Image类型时存在） */
  imageInfo?: { width: number; height: number };
  /** 资源 ID（若服务端返回） */
  resourceId?: string;
};

/** Media文件Description */
export type MediaFile = {
  /** 文件原始名称（含扩展名） */
  filename: string;
  /** 文件内容（Buffer） */
  data: Buffer;
  /** MIME 类型，如 image/jpeg、application/pdf */
  mimeType: string;
};

// ============ 常量 ============

const DEFAULT_MAX_MB = 20;

/** Image扩展名集合（小写） */
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

// ============ Utility functions ============

/**
 * 根据文件名判断 MIME 类型
 *
 * @param filename - 文件名（含扩展名，如 photo.jpg）
 * @returns MIME 类型字符串，无法识别时返回 "application/octet-stream"
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
 * 判断是否为Image类型（MIME 或扩展名）
 */
function isImage(filename: string, mimeType?: string): boolean {
  if (mimeType?.startsWith("image/")) {
    return true;
  }
  return IMAGE_EXTS.has(extname(filename).toLowerCase());
}

/**
 * 生成随机文件 ID（用于 fileId 参数）
 */
function generateFileId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * 计算 Buffer 的 MD5 哈希，返回 hex 字符串
 */
function md5Hex(buffer: Buffer): string {
  return createHash("md5").update(buffer).digest("hex");
}

/**
 * 从Image Buffer 中解析宽高（支持 JPEG / PNG / GIF / WebP），无需额外依赖。
 * 依次尝试各格式的魔数匹配，首个命中即返回；全部未命中则返回 undefined。
 *
 * @param buf - Image文件的原始二进制数据
 * @returns 解析成功时返回 `{ width, height }`（单位：像素），无法识别格式时返回 `undefined`
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

// ============ 本地路径工具 ============

/**
 * 判断给定字符串是否为本地文件路径（而非远程 URL）。
 *
 * Matches the following patterns:
 * - `file://` 协议
 * - tilde 路径：`~`、`~/`、`~\`
 * - Unix 绝对路径：`/`
 * - Windows 盘符路径：`C:\`、`C:/`
 * - Windows UNC 路径：`\\`
 * - 相对路径：`./`、`../`、`.\`、`..\`
 * - 裸文件名（无 scheme，不含 `://`）：`hello.md`、`subdir/file.txt`
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
    !s.includes("://") // 无 scheme → 本地路径（裸文件名 / 裸相对路径）
  );
}

/**
 * Normalize local path:
 * 1. 去除首尾空白
 * 2. 剥离 `file://` 前缀并 URI decode
 * 3. 展开 tilde（`~`）为真实 home Directory
 * 4. 将相对路径（含裸文件名）解析为绝对路径
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

// ============ 下载 ============

/** 将 content-type 映射到文件扩展名 */
const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
};

/**
 * 从 HTTP 响应头的 content-disposition 中Extract文件名。
 * 支持 `filename=` 和 `filename*=UTF-8''` 两种格式。
 */
function extractFilenameFromContentDisposition(contentDisp: string): string {
  const match = contentDisp.match(/filename\*?=(?:UTF-8'')?["']?([^;"'\r\n]+)/i);
  if (!match) {
    return "";
  }
  return decodeURIComponent(match[1].replace(/"/g, "")).trim();
}

/**
 * 根据 HTTP 响应推断文件名（兜底逻辑，调用方应优先使用消息元数据中的文件名）。
 * Priority:content-disposition > URL 路径 > 随机 hex + 扩展名
 *
 * @param response - fetch 响应对象，用于读取 content-disposition 头
 * @param fetchUrl - 实际请求的 URL，用于从路径中Extract文件名
 * @param contentType - 响应的 MIME 类型，用于在无扩展名时补充后缀
 * @returns 推断出的文件名字符串
 */
function inferFilenameFromResponse(
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

  // 2. URL 路径末段
  const fromPath = basename(new URL(fetchUrl).pathname).trim();
  if (fromPath) {
    // 无扩展名时从 content-type 补充
    const inferredExt =
      MIME_TO_EXT[contentType] ??
      (contentType.startsWith("image/") ? `.${contentType.split("/")[1]}` : "");
    return extname(fromPath) ? fromPath : `${fromPath}${inferredExt}`;
  }

  // 3. 随机兜底
  const inferredExt = MIME_TO_EXT[contentType] ?? "";
  return `${randomBytes(8).toString("hex")}${inferredExt}`;
}

/**
 * 解析实际下载 URL：若含 resourceId 参数则通过元宝接口换取真实下载地址。
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
 * 从 URL 下载文件到 Buffer。
 *
 * Supports two sources:
 * - `file://` 或绝对路径 — 本地文件，直接读取
 * - `http(s)://` — 远程 URL，若含 `resourceId` 查询参数则自动换取元宝真实下载地址
 *
 * Note:返回的 `filename` 仅作兜底，调用方应优先使用消息元数据中的 `mediaName`。
 *
 * @param url - 资源 URL 或本地路径
 * @param maxMb - 最大允许大小（MB）
 * @param account - 可选，含 resourceId 时用于换取下载地址
 * @returns Media文件对象（含 Buffer、文件名、MIME 类型）
 */
export async function downloadMediaForYuanbao(
  url: string,
  maxMb = DEFAULT_MAX_MB,
  account?: ResolvedYuanbaoAccount,
): Promise<MediaFile> {
  const maxBytes = maxMb * 1024 * 1024;

  // 本地文件（file://、绝对路径、tilde 路径、相对路径等）
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

  // 远程 URL
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
 * 通过 OpenClaw SDK 加载Media资源并转换为 MediaFile。
 * 与 {@link downloadMediaForYuanbao} 不同，此函数依赖 core.media.loadWebMedia 处理本地路径解析和大小限制，
 * 适用于插件环境下需要受 localRoots 沙箱约束的场景。
 *
 * @param url - Media资源 URL 或本地路径
 * @param core - OpenClaw PluginRuntime 实例，用于调用 media.loadWebMedia 加载资源
 * @param mediaLocalRoots - 允许访问的本地Directory白名单，限制本地文件读取范围
 * @param account - 元宝账号配置，用于获取 mediaMaxMb 大小限制
 * @returns 包含文件内容 Buffer、文件名和 MIME 类型的Media文件对象
 * @throws {Error} 当 account 未提供时抛出，因为需要从中读取上传大小限制
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

  // 降级：downloadMediaForYuanbao 已支持 HTTP URL 和本地路径（含 file://、绝对路径、tilde 等），
  // 且在读取前会校验文件大小，避免加载超限文件。
  return downloadMediaForYuanbao(url, account.mediaMaxMb, account);
}

// ============ COS 上传 ============

/**
 * 最小化 COS 上传实现（Node.js Buffer，不依赖浏览器 API）
 * 复用 cos-js-sdk-v5 SDK，参数与元宝 Web 端一致。
 *
 * @param params - 上传参数（COS 预签配置、文件 Buffer、文件名、MIME 类型、进度回调）
 * @returns COS 资源公网 URL
 */
async function uploadBufferToCos(params: {
  config: CosUploadConfig;
  data: Buffer;
  filename: string;
  mimeType: string;
  onProgress?: (percent: number) => void;
}): Promise<string> {
  const { config, data, filename, mimeType } = params;

  // 动态 import，避免在未安装 SDK 时报错
  // cos-nodejs-sdk-v5 使用 CommonJS export = 语法，需兼容处理
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- COS SDK 动态加载
  let COS: any;
  try {
    // 优先用 require（Node.js CJS 兼容路径）
    COS = require("cos-nodejs-sdk-v5");
    if (COS?.default) {
      COS = COS.default;
    }
  } catch {
    // CJS require 失败，尝试 ESM import
    try {
      const pkg = await import("cos-nodejs-sdk-v5" as string);
      COS = pkg.default ?? pkg;
    } catch {
      // CJS 和 ESM 均失败，抛出明确错误
      throw new Error("缺少依赖 cos-nodejs-sdk-v5，请运行 pnpm add cos-nodejs-sdk-v5");
    }
  }

  const cos = new COS({
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

  // 构造请求头
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

// ============ 主要公开 API ============

/**
 * 上传 Buffer 到 COS（通过 api.ts 获取预签配置，自动处理鉴权）
 *
 * @param mediaFile - Media文件（含 data、filename、mimeType）
 * @param account - 账号配置（用于自动获取鉴权 token）
 * @param onProgress - 进度回调（0-100）
 * @returns 上传结果（含公网 URL）
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

  // 1. 获取 COS 预签配置（自动带鉴权头）
  const cosConfig = await apiGetUploadInfo(account, filename, fileId);

  // 2. 上传到 COS
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
 * 从 URL/本地路径/resourceId 下载并上传到 COS（一站式）
 *
 * @param mediaUrl - Media URL、本地路径或 resource:<id> 格式
 * @param account - 账号配置（用于 resource: 下载鉴权和 COS 上传）
 * @param onProgress - 进度回调
 * @returns 上传结果（含公网 URL、文件名、大小）
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

// ============ 腾讯 IM Media消息构建 ============

/**
 * 构建腾讯 IM TIMImageElem Message body
 * 参考：https://cloud.tencent.com/document/product/269/2720
 *
 * @param params - Image参数（url、可选 filename 和 size）
 * @returns TIMImageElem 格式的Message body数组
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
 * 构建腾讯 IM TIMFileElem Message body
 * 参考：https://cloud.tencent.com/document/product/269/2720
 *
 * @param params - 文件参数（url、filename 必填，可选 size）
 * @returns TIMFileElem 格式的Message body数组
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

// ============ 批量下载并保存 ============

/**
 * Download media资源列表并保存到 agent 允许访问的Directory，返回本地文件路径列表。
 * - MIME 类型优先从 HTTP 响应头获取，缺失时通过 core.media.detectMime 从 Buffer 检测
 * - 文件名优先使用 mediaName（如腾讯 IM 的 file_name 字段），其次从响应头/URL 推断
 * - 下载失败的Media会被跳过并记录警告日志
 *
 * @param medias - Media资源列表
 * @param account - 账号配置（用于鉴权）
 * @param core - OpenClaw PluginRuntime（用于 detectMime 和 saveMediaBuffer）
 * @param log - 日志函数（verbose / warn）
 * @returns 本地文件路径列表
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

  // 最多下载 20 个Media，并发执行
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
