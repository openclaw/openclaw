/**
 * 媒体 IO 模块
 *
 * 提供统一的媒体文件下载和读取功能
 *
 * @module @openclaw/china-shared/media
 */

import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import { isHttpUrl, normalizeLocalPath, getExtension } from "./media-parser.js";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 媒体读取结果
 */
export interface MediaReadResult {
  /** 文件内容 Buffer */
  buffer: Buffer;
  /** 文件名 */
  fileName: string;
  /** 文件大小（字节） */
  size: number;
  /** MIME 类型（如果可检测） */
  mimeType?: string;
}

/**
 * 媒体读取选项
 */
export interface MediaReadOptions {
  /** 超时时间（毫秒），默认 30000 */
  timeout?: number;
  /** 最大文件大小（字节），默认 100MB */
  maxSize?: number;
  /** 自定义 fetch 函数（用于依赖注入） */
  fetch?: typeof globalThis.fetch;
}

/**
 * 路径安全检查选项
 */
export interface PathSecurityOptions {
  /** 允许的路径前缀白名单 */
  allowedPrefixes?: string[];
  /** 最大路径长度，默认 4096 */
  maxPathLength?: number;
  /** 是否禁止路径穿越，默认 true */
  preventTraversal?: boolean;
}

// ============================================================================
// 常量定义
// ============================================================================

/** 默认超时时间（毫秒） */
const DEFAULT_TIMEOUT = 30000;

/** 默认最大文件大小（100MB） */
const DEFAULT_MAX_SIZE = 100 * 1024 * 1024;

/** 默认最大路径长度 */
const DEFAULT_MAX_PATH_LENGTH = 4096;

/** 默认允许的路径前缀（Unix） */
const DEFAULT_UNIX_PREFIXES = ["/tmp", "/var/tmp", "/private/tmp", "/Users", "/home", "/root"];

/** 扩展名到 MIME 类型映射 */
const EXT_TO_MIME: Record<string, string> = {
  // 图片
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  // 音频
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/x-m4a",
  amr: "audio/amr",
  // 视频
  mp4: "video/mp4",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  webm: "video/webm",
  // 文档
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
  // 压缩包
  zip: "application/zip",
  rar: "application/x-rar-compressed",
  "7z": "application/x-7z-compressed",
  tar: "application/x-tar",
  gz: "application/gzip",
};

// ============================================================================
// 错误类
// ============================================================================

/**
 * 文件大小超限错误
 */
export class FileSizeLimitError extends Error {
  /** 实际文件大小（字节） */
  public readonly actualSize: number;
  /** 大小限制（字节） */
  public readonly limitSize: number;

  constructor(actualSize: number, limitSize: number) {
    super(`File size ${actualSize} bytes exceeds limit ${limitSize} bytes`);
    this.name = "FileSizeLimitError";
    this.actualSize = actualSize;
    this.limitSize = limitSize;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, FileSizeLimitError);
    }
  }
}

/**
 * 下载超时错误
 */
export class MediaTimeoutError extends Error {
  /** 超时时间（毫秒） */
  public readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Operation timed out after ${timeoutMs}ms`);
    this.name = "MediaTimeoutError";
    this.timeoutMs = timeoutMs;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MediaTimeoutError);
    }
  }
}

/**
 * 路径安全错误
 */
export class PathSecurityError extends Error {
  /** 不安全的路径 */
  public readonly unsafePath: string;
  /** 错误原因 */
  public readonly reason: string;

  constructor(unsafePath: string, reason: string) {
    super(`Path security violation: ${reason} - ${unsafePath}`);
    this.name = "PathSecurityError";
    this.unsafePath = unsafePath;
    this.reason = reason;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, PathSecurityError);
    }
  }
}

// ============================================================================
// 路径安全检查
// ============================================================================

/**
 * 检查路径是否安全
 *
 * @param filePath - 要检查的路径
 * @param options - 安全检查选项
 * @throws PathSecurityError 如果路径不安全
 */
export function validatePathSecurity(filePath: string, options: PathSecurityOptions = {}): void {
  const {
    allowedPrefixes,
    maxPathLength = DEFAULT_MAX_PATH_LENGTH,
    preventTraversal = true,
  } = options;

  // 检查路径长度
  if (filePath.length > maxPathLength) {
    throw new PathSecurityError(
      filePath,
      `Path length ${filePath.length} exceeds maximum ${maxPathLength}`,
    );
  }

  // 检查路径穿越
  if (preventTraversal) {
    const normalized = path.normalize(filePath);
    if (normalized.includes("..")) {
      throw new PathSecurityError(filePath, "Path traversal detected");
    }
  }

  // 检查路径前缀白名单
  if (allowedPrefixes && allowedPrefixes.length > 0) {
    const normalizedPath = path.normalize(filePath);
    const isAllowed = allowedPrefixes.some((prefix) =>
      normalizedPath.startsWith(path.normalize(prefix)),
    );
    if (!isAllowed) {
      throw new PathSecurityError(
        filePath,
        `Path not in allowed prefixes: ${allowedPrefixes.join(", ")}`,
      );
    }
  }
}

/**
 * 获取默认的路径白名单
 */
export function getDefaultAllowedPrefixes(): string[] {
  if (process.platform === "win32") {
    // Windows: 允许所有驱动器的临时目录和用户目录
    const tempDir = os.tmpdir();
    const homeDir = os.homedir();
    return [tempDir, homeDir];
  }
  return DEFAULT_UNIX_PREFIXES;
}

// ============================================================================
// MIME 类型检测
// ============================================================================

/**
 * 根据文件扩展名获取 MIME 类型
 */
export function getMimeType(filePath: string): string | undefined {
  const ext = getExtension(filePath);
  return EXT_TO_MIME[ext];
}

// ============================================================================
// 媒体读取函数
// ============================================================================

/**
 * 从 HTTP URL 下载媒体
 *
 * @param url - 媒体 URL
 * @param options - 读取选项
 * @returns 媒体读取结果
 */
export async function fetchMediaFromUrl(
  url: string,
  options: MediaReadOptions = {},
): Promise<MediaReadResult> {
  const {
    timeout = DEFAULT_TIMEOUT,
    maxSize = DEFAULT_MAX_SIZE,
    fetch: customFetch = globalThis.fetch,
  } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await customFetch(url, { signal: controller.signal });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    // 检查 Content-Length
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      if (size > maxSize) {
        throw new FileSizeLimitError(size, maxSize);
      }
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 检查实际大小
    if (buffer.length > maxSize) {
      throw new FileSizeLimitError(buffer.length, maxSize);
    }

    // 提取文件名
    let fileName = "file";
    try {
      const urlPath = new URL(url).pathname;
      fileName = path.basename(urlPath) || "file";
    } catch {
      // 忽略 URL 解析错误
    }

    // 获取 MIME 类型
    const mimeType =
      response.headers.get("content-type")?.split(";")[0].trim() || getMimeType(fileName);

    return {
      buffer,
      fileName,
      size: buffer.length,
      mimeType,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new MediaTimeoutError(timeout);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 从本地路径读取媒体
 *
 * @param filePath - 本地文件路径（支持 file://, MEDIA:, attachment:// 前缀）
 * @param options - 读取选项
 * @returns 媒体读取结果
 */
export async function readMediaFromLocal(
  filePath: string,
  options: MediaReadOptions & PathSecurityOptions = {},
): Promise<MediaReadResult> {
  const { maxSize = DEFAULT_MAX_SIZE } = options;

  // 规范化路径
  const localPath = normalizeLocalPath(filePath);

  // 安全检查
  validatePathSecurity(localPath, options);

  // 检查文件存在性
  if (!fs.existsSync(localPath)) {
    throw new Error(`File not found: ${localPath}`);
  }

  // 检查文件大小
  const stats = await fsPromises.stat(localPath);
  if (stats.size > maxSize) {
    throw new FileSizeLimitError(stats.size, maxSize);
  }

  // 读取文件
  const buffer = await fsPromises.readFile(localPath);
  const fileName = path.basename(localPath);
  const mimeType = getMimeType(localPath);

  return {
    buffer,
    fileName,
    size: buffer.length,
    mimeType,
  };
}

/**
 * 统一的媒体读取函数
 * 自动判断是 HTTP URL 还是本地路径
 *
 * @param source - 媒体源（URL 或本地路径）
 * @param options - 读取选项
 * @returns 媒体读取结果
 */
export async function readMedia(
  source: string,
  options: MediaReadOptions & PathSecurityOptions = {},
): Promise<MediaReadResult> {
  if (isHttpUrl(source)) {
    return fetchMediaFromUrl(source, options);
  }
  return readMediaFromLocal(source, options);
}

/**
 * 批量读取媒体
 *
 * @param sources - 媒体源列表
 * @param options - 读取选项
 * @returns 媒体读取结果列表（包含成功和失败的结果）
 */
export async function readMediaBatch(
  sources: string[],
  options: MediaReadOptions & PathSecurityOptions = {},
): Promise<Array<{ source: string; result?: MediaReadResult; error?: Error }>> {
  const results = await Promise.allSettled(sources.map((source) => readMedia(source, options)));

  return results.map((result, index) => {
    if (result.status === "fulfilled") {
      return { source: sources[index], result: result.value };
    }
    return { source: sources[index], error: result.reason as Error };
  });
}
