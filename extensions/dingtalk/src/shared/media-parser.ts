/**
 * 媒体解析模块
 *
 * 提供统一的媒体路径提取、解析和规范化功能
 * 支持 Markdown 图片、HTML img 标签、MEDIA: 标记、本地路径等多种格式
 *
 * @module @openclaw/china-shared/media
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 媒体类型
 */
export type MediaType = "image" | "audio" | "video" | "file";

/**
 * 媒体来源类型
 */
export type MediaSourceKind = "markdown" | "markdown-linked" | "html" | "bare";

/**
 * 提取的媒体项
 */
export interface ExtractedMedia {
  /** 原始路径或 URL */
  source: string;
  /** 规范化后的本地路径（仅本地文件有效） */
  localPath?: string;
  /** 媒体类型 */
  type: MediaType;
  /** 是否为本地文件 */
  isLocal: boolean;
  /** 是否为 HTTP URL */
  isHttp: boolean;
  /** 文件名 */
  fileName?: string;
  /** 来源类型：markdown/html/bare */
  sourceKind?: MediaSourceKind;
}

/**
 * 媒体解析结果
 */
export interface MediaParseResult {
  /** 清理后的文本（移除媒体标记） */
  text: string;
  /** 提取的图片列表 */
  images: ExtractedMedia[];
  /** 提取的非图片文件列表 */
  files: ExtractedMedia[];
  /** 所有媒体列表（图片 + 文件） */
  all: ExtractedMedia[];
}

/**
 * 媒体解析选项
 */
export interface MediaParseOptions {
  /** 是否从文本中移除媒体标记，默认 true */
  removeFromText?: boolean;
  /** 是否检查本地文件存在性，默认 false */
  checkExists?: boolean;
  /** 文件存在性检查函数（用于依赖注入） */
  existsSync?: (path: string) => boolean;
  /** 是否解析行首 MEDIA: 指令，默认 false */
  parseMediaLines?: boolean;
  /** 是否解析 Markdown 图片，默认 true */
  parseMarkdownImages?: boolean;
  /** 是否解析 HTML img 标签，默认 true */
  parseHtmlImages?: boolean;
  /** 是否解析裸露的本地路径，默认 true */
  parseBarePaths?: boolean;
  /** 是否解析 Markdown 链接中的文件，默认 true */
  parseMarkdownLinks?: boolean;
}

// ============================================================================
// 常量定义
// ============================================================================

/**
 * 图片扩展名集合
 */
export const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "tif",
  "heic",
  "heif",
  "svg",
  "ico",
]);

/**
 * 音频扩展名集合
 */
export const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "m4a", "amr", "flac", "aac", "wma"]);

/**
 * 视频扩展名集合
 */
export const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "avi", "mkv", "webm", "flv", "wmv", "m4v"]);

/**
 * 非图片文件扩展名集合（用于文件提取）
 */
export const NON_IMAGE_EXTENSIONS = new Set([
  // 文档
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "csv",
  "ppt",
  "pptx",
  "txt",
  "md",
  "rtf",
  "odt",
  "ods",
  // 压缩包
  "zip",
  "rar",
  "7z",
  "tar",
  "gz",
  "tgz",
  "bz2",
  // 音频
  ...AUDIO_EXTENSIONS,
  // 视频
  ...VIDEO_EXTENSIONS,
  // 数据
  "json",
  "xml",
  "yaml",
  "yml",
]);

// ============================================================================
// 正则表达式
// ============================================================================

/**
 * Markdown 图片语法: ![alt](path)
 * 支持 file://, MEDIA:, attachment://, 绝对路径
 */
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

/**
 * Markdown 链接中的图片: [![alt](img)](link)
 */
const MARKDOWN_LINKED_IMAGE_RE = /\[!\[([^\]]*)\]\(([^)]+)\)\]\(([^)]+)\)/g;

/**
 * HTML img 标签
 */
const HTML_IMAGE_RE = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi;

/**
 * Markdown 链接语法: [label](path)
 */
const MARKDOWN_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

/**
 * 本地图片路径（裸露的，非 Markdown 格式）
 * 支持 Unix 和 Windows 路径
 */
const BARE_IMAGE_PATH_RE =
  /`?((?:\/(?:tmp|var|private|Users|home|root)\/[^\s`'",)]+|[A-Za-z]:[\\/][^\s`'",)]+)\.(?:png|jpg|jpeg|gif|bmp|webp|svg|ico))`?/gi;

/**
 * 本地文件路径（非图片）
 * 动态生成，包含所有非图片扩展名
 */
const NON_IMAGE_EXT_PATTERN = Array.from(NON_IMAGE_EXTENSIONS).join("|");
const WINDOWS_PATH_SEP = String.raw`(?:\\\\|\\)`;
const WINDOWS_FILE_PATH = String.raw`[A-Za-z]:${WINDOWS_PATH_SEP}(?:[^\\/:*?"<>|\r\n]+${WINDOWS_PATH_SEP})*[^\\/:*?"<>|\r\n]+`;
const UNIX_FILE_PATH = String.raw`\/(?:tmp|var|private|Users|home|root)\/[^\s'",)]+`;
const BARE_FILE_PATH_RE = new RegExp(
  String.raw`\`?((?:${UNIX_FILE_PATH}|${WINDOWS_FILE_PATH})\.(?:${NON_IMAGE_EXT_PATTERN}))\`?`,
  "gi",
);

// MEDIA: 行解析辅助
const MEDIA_LINE_PREFIX = "MEDIA:";

function unwrapMediaLinePayload(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return undefined;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (first !== last) {
    return undefined;
  }
  if (first !== `"` && first !== "'" && first !== "`") {
    return undefined;
  }
  return trimmed.slice(1, -1).trim();
}

function cleanMediaLineCandidate(value: string): string {
  return value.replace(/^[`"'[{(<]+/, "").replace(/[`"'\])}>.,;]+$/, "");
}

function splitMediaLineCandidates(payload: string): string[] {
  const unwrapped = unwrapMediaLinePayload(payload);
  if (unwrapped) {
    return [unwrapped];
  }
  return payload.split(/\s+/).filter(Boolean);
}

// ============================================================================
// 路径处理函数
// ============================================================================

/**
 * 检查是否为 HTTP/HTTPS URL
 */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * 检查是否为 file:// URL
 */
export function isFileUrl(value: string): boolean {
  return /^file:\/\//i.test(value);
}

/**
 * 检查是否为本地路径引用
 * 支持 file://, MEDIA:, attachment://, 绝对路径
 */
export function isLocalReference(raw: string): boolean {
  if (isHttpUrl(raw)) {
    return false;
  }
  return (
    raw.startsWith("file://") ||
    raw.startsWith("MEDIA:") ||
    raw.startsWith("attachment://") ||
    raw.startsWith("/") ||
    raw.startsWith("~") ||
    /^[a-zA-Z]:[\\/]/.test(raw)
  );
}

/**
 * 规范化本地路径
 * 移除 file://, MEDIA:, attachment:// 前缀，并解码 URI
 */
export function normalizeLocalPath(raw: string): string {
  let p = raw.trim();

  // 处理 file:// URL
  if (isFileUrl(p)) {
    try {
      return fileURLToPath(p);
    } catch {
      p = p.replace(/^file:\/\/\/?/i, "");
    }
  }

  // 处理其他前缀
  if (p.startsWith("MEDIA:")) {
    p = p.replace(/^MEDIA:/i, "");
  } else if (p.startsWith("attachment://")) {
    p = p.replace(/^attachment:\/\//i, "");
  }

  // 处理转义空格
  p = p.replace(/\\ /g, " ");

  // 尝试 URI 解码
  try {
    p = decodeURIComponent(p);
  } catch {
    // 忽略解码错误
  }

  // 处理波浪号路径 (~)
  if (p.startsWith("~/") || p === "~") {
    p = path.join(os.homedir(), p.slice(1));
  } else if (p.startsWith("~")) {
    // ~username 格式，在 Windows 上不常见，保持原样
    // 在 Unix 上可以用 os.homedir() 的父目录 + username，但这里简化处理
  }

  // 处理相对路径
  if (!path.isAbsolute(p)) {
    p = path.resolve(process.cwd(), p);
  }

  return p;
}

/**
 * 从 URL 中移除标题部分（Markdown 语法中的 "title"）
 */
export function stripTitleFromUrl(value: string): string {
  const trimmed = value.trim();
  // Only strip when the title is explicitly quoted: url "title" or url 'title'
  const match = trimmed.match(/^(\S+)\s+["'][^"']*["']\s*$/);
  return match ? match[1] : trimmed;
}

/**
 * 获取文件扩展名（不含点）
 */
export function getExtension(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return ext.startsWith(".") ? ext.slice(1) : ext;
}

/**
 * 检查是否为图片路径
 */
export function isImagePath(filePath: string): boolean {
  const ext = getExtension(filePath);
  return ext ? IMAGE_EXTENSIONS.has(ext) : false;
}

/**
 * 检查是否为非图片文件路径
 */
export function isNonImageFilePath(filePath: string): boolean {
  const ext = getExtension(filePath);
  return ext ? NON_IMAGE_EXTENSIONS.has(ext) : false;
}

/**
 * 根据文件扩展名检测媒体类型
 */
export function detectMediaType(filePath: string): MediaType {
  const ext = getExtension(filePath);

  if (IMAGE_EXTENSIONS.has(ext)) {
    return "image";
  }
  if (AUDIO_EXTENSIONS.has(ext)) {
    return "audio";
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return "video";
  }

  return "file";
}

// ============================================================================
// 媒体提取函数
// ============================================================================

/**
 * 创建 ExtractedMedia 对象
 */
function createExtractedMedia(
  source: string,
  sourceKind: MediaSourceKind,
  _options?: MediaParseOptions,
): ExtractedMedia {
  const isHttp = isHttpUrl(source);
  const isLocal = !isHttp && isLocalReference(source);
  const cleanSource = stripTitleFromUrl(source);

  let localPath: string | undefined;
  let fileName: string | undefined;

  if (isLocal) {
    localPath = normalizeLocalPath(cleanSource);
    fileName = path.basename(localPath);
  } else if (isHttp) {
    try {
      const url = new URL(cleanSource);
      fileName = path.basename(url.pathname) || undefined;
    } catch {
      // 忽略 URL 解析错误
    }
  }

  const type = detectMediaType(fileName || cleanSource);

  return {
    source: cleanSource,
    localPath,
    type,
    isLocal,
    isHttp,
    fileName,
    sourceKind,
  };
}

/**
 * 从文本中提取所有媒体
 *
 * @param text - 要解析的文本
 * @param options - 解析选项
 * @returns 解析结果，包含清理后的文本和提取的媒体列表
 */
export function extractMediaFromText(
  text: string,
  options: MediaParseOptions = {},
): MediaParseResult {
  const {
    removeFromText = true,
    checkExists = false,
    existsSync,
    parseMediaLines = false,
    parseMarkdownImages = true,
    parseHtmlImages = true,
    parseBarePaths = true,
    parseMarkdownLinks = true,
  } = options;

  const images: ExtractedMedia[] = [];
  const files: ExtractedMedia[] = [];
  const seenSources = new Set<string>();
  let result = text;

  // 辅助函数：添加媒体项（去重）
  const addMedia = (media: ExtractedMedia): boolean => {
    const key = media.localPath || media.source;
    if (seenSources.has(key)) {
      return false;
    }

    // 检查文件存在性
    if (checkExists && media.isLocal && media.localPath) {
      const exists = existsSync ? existsSync(media.localPath) : fs.existsSync(media.localPath);
      if (!exists) {
        return false;
      }
    }

    seenSources.add(key);

    if (media.type === "image") {
      images.push(media);
    } else {
      files.push(media);
    }
    return true;
  };

  // 0. 解析行首 MEDIA: 指令
  if (parseMediaLines) {
    const lines = result.split("\n");
    const keptLines: string[] = [];
    for (const line of lines) {
      const trimmedStart = line.trimStart();
      if (!trimmedStart.startsWith(MEDIA_LINE_PREFIX)) {
        keptLines.push(line);
        continue;
      }

      const payload = trimmedStart.slice(MEDIA_LINE_PREFIX.length).trim();
      if (!payload) {
        keptLines.push(line);
        continue;
      }

      const candidates = splitMediaLineCandidates(payload);
      let addedAny = false;
      for (const raw of candidates) {
        const candidate = stripTitleFromUrl(cleanMediaLineCandidate(raw));
        if (!candidate) {
          continue;
        }
        if (!isHttpUrl(candidate) && !isLocalReference(candidate)) {
          continue;
        }
        const media = createExtractedMedia(candidate, "bare", options);
        if (addMedia(media)) {
          addedAny = true;
        }
      }

      if (!addedAny || !removeFromText) {
        keptLines.push(line);
      }
    }

    if (removeFromText) {
      result = keptLines.join("\n");
    }
  }

  // 收集需要替换的位置（用于安全替换）
  type Replacement = { start: number; end: number; replacement: string };
  const replacements: Replacement[] = [];

  // 辅助函数：应用曦换（从后向前，避免索引错位）
  const applyReplacements = (): void => {
    if (replacements.length === 0) {
      return;
    }
    // 按起始位置降序排序，从后向前曦换
    replacements.sort((a, b) => b.start - a.start);
    for (const { start, end, replacement } of replacements) {
      result = result.slice(0, start) + replacement + result.slice(end);
    }
    replacements.length = 0; // 清空
  };

  // 1. 解析 Markdown 链接中的图片: [![alt](img)](link)
  if (parseMarkdownImages) {
    const linkedMatches = [...text.matchAll(MARKDOWN_LINKED_IMAGE_RE)];
    for (const match of linkedMatches) {
      const [fullMatch, _alt, imgSrc] = match;
      const media = createExtractedMedia(imgSrc, "markdown", options);
      if (media.type === "image") {
        addMedia(media);
        if (removeFromText && match.index !== undefined) {
          replacements.push({
            start: match.index,
            end: match.index + fullMatch.length,
            replacement: "",
          });
        }
      }
    }
    applyReplacements();
  }

  // 2. 解析 Markdown 图片: ![alt](path)
  if (parseMarkdownImages) {
    const mdMatches = [...result.matchAll(MARKDOWN_IMAGE_RE)];
    for (const match of mdMatches) {
      const [fullMatch, _alt, src] = match;
      const media = createExtractedMedia(src, "markdown", options);
      if (media.type === "image") {
        addMedia(media);
        if (removeFromText && match.index !== undefined) {
          replacements.push({
            start: match.index,
            end: match.index + fullMatch.length,
            replacement: "",
          });
        }
      }
    }
    applyReplacements();
  }

  // 3. 解析 HTML img 标签
  if (parseHtmlImages) {
    const htmlMatches = [...result.matchAll(HTML_IMAGE_RE)];
    for (const match of htmlMatches) {
      const [fullMatch, src1, src2, src3] = match;
      const src = src1 || src2 || src3;
      if (src) {
        const media = createExtractedMedia(src, "html", options);
        if (media.type === "image") {
          addMedia(media);
          if (removeFromText && match.index !== undefined) {
            replacements.push({
              start: match.index,
              end: match.index + fullMatch.length,
              replacement: "",
            });
          }
        }
      }
    }
    applyReplacements();
  }

  // 4. 解析 Markdown 链接中的文件: [label](path)
  if (parseMarkdownLinks) {
    // 重置正则
    MARKDOWN_LINK_RE.lastIndex = 0;
    const linkMatches = [...result.matchAll(MARKDOWN_LINK_RE)];
    for (const match of linkMatches) {
      const [fullMatch, _label, rawPath] = match;
      const idx = match.index ?? 0;

      // 跳过图片语法 ![...](...)  - 检查前一个字符是否为 !
      if (idx > 0 && result[idx - 1] === "!") {
        continue;
      }

      // 只处理本地引用
      if (!isLocalReference(rawPath)) {
        continue;
      }

      const media = createExtractedMedia(rawPath, "markdown", options);

      // 只处理非图片文件
      if (media.type !== "image" && isNonImageFilePath(media.localPath || rawPath)) {
        if (addMedia(media)) {
          if (removeFromText && match.index !== undefined) {
            const fileName = media.fileName || path.basename(rawPath);
            replacements.push({
              start: match.index,
              end: match.index + fullMatch.length,
              replacement: `[文件: ${fileName}]`,
            });
          }
        }
      }
    }
    applyReplacements();
  }

  // 5. 解析裸露的本地图片路径
  if (parseBarePaths && parseMarkdownImages) {
    // 重置正则
    BARE_IMAGE_PATH_RE.lastIndex = 0;
    const bareImageMatches = [...result.matchAll(BARE_IMAGE_PATH_RE)];

    // 过滤掉已经在 Markdown 语法中的路径
    const newBareImageMatches = bareImageMatches.filter((m) => {
      const idx = m.index ?? 0;
      const before = result.slice(Math.max(0, idx - 10), idx);
      return !before.includes("](");
    });

    for (const match of newBareImageMatches) {
      const [fullMatch, rawPath] = match;
      const media = createExtractedMedia(rawPath, "bare", options);
      if (media.type === "image") {
        addMedia(media);
        if (removeFromText && match.index !== undefined) {
          replacements.push({
            start: match.index,
            end: match.index + fullMatch.length,
            replacement: "",
          });
        }
      }
    }
    applyReplacements();
  }

  // 6. 解析裸露的本地文件路径（非图片）
  if (parseBarePaths && parseMarkdownLinks) {
    // 重置正则
    BARE_FILE_PATH_RE.lastIndex = 0;
    const bareFileMatches = [...result.matchAll(BARE_FILE_PATH_RE)];

    for (const match of bareFileMatches) {
      const [fullMatch, rawPath] = match;
      const media = createExtractedMedia(rawPath, "bare", options);

      if (media.type !== "image") {
        if (addMedia(media)) {
          if (removeFromText && match.index !== undefined) {
            const fileName = media.fileName || path.basename(rawPath);
            replacements.push({
              start: match.index,
              end: match.index + fullMatch.length,
              replacement: `[文件: ${fileName}]`,
            });
          }
        }
      }
    }
    applyReplacements();
  }

  // 清理多余的空行
  if (removeFromText) {
    result = result.replace(/\n{3,}/g, "\n\n").trim();
  }

  return {
    text: result,
    images,
    files,
    all: [...images, ...files],
  };
}

/**
 * 仅提取图片（简化版）
 */
export function extractImagesFromText(
  text: string,
  options: Omit<MediaParseOptions, "parseMarkdownLinks"> = {},
): { text: string; images: ExtractedMedia[] } {
  const result = extractMediaFromText(text, {
    ...options,
    parseMarkdownLinks: false,
  });
  return {
    text: result.text,
    images: result.images,
  };
}

/**
 * 仅提取文件（简化版）
 */
export function extractFilesFromText(
  text: string,
  options: Omit<MediaParseOptions, "parseMarkdownImages" | "parseHtmlImages"> = {},
): { text: string; files: ExtractedMedia[] } {
  const result = extractMediaFromText(text, {
    ...options,
    parseMarkdownImages: false,
    parseHtmlImages: false,
  });
  return {
    text: result.text,
    files: result.files,
  };
}
