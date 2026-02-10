import type { ResolvedDingTalkAccount } from "./types.js";
import { getFileDownloadUrl, downloadFromUrl } from "./client.js";
import { getDingTalkRuntime } from "./runtime.js";
import { logger } from "./logger.js";

// ============================================================================
// 媒体信息类型定义
// ============================================================================

/** 媒体类型枚举（与钉钉消息类型一致） */
export type MediaKind = "picture" | "audio" | "video" | "file";

/** 单个媒体项 */
export interface MediaItem {
  /** 媒体类型 */
  kind: MediaKind;
  /** 本地文件路径 */
  path: string;
  /** MIME 类型 */
  contentType: string;
  /** 文件名（可选） */
  fileName?: string;
  /** 文件大小（字节） */
  fileSize?: number;
  /** 时长（秒，音视频专用） */
  duration?: number;
}

/** 入站消息的媒体上下文 */
export interface InboundMediaContext {
  /** 媒体项列表（支持多媒体混排） */
  items: MediaItem[];
  /** 主媒体（第一个媒体项，兼容旧逻辑） */
  primary?: MediaItem;
}

/** 生成媒体占位符文本 */
export function generateMediaPlaceholder(media: InboundMediaContext): string {
  if (media.items.length === 0) return "";

  return media.items
    .map((item) => {
      switch (item.kind) {
        case "picture":
          return "<media:picture>";
        case "audio":
          return `<media:audio${item.duration ? ` duration=${item.duration}s` : ""}>`;
        case "video":
          return `<media:video${item.duration ? ` duration=${item.duration}s` : ""}>`;
        case "file":
          return `<media:file${item.fileName ? ` name="${item.fileName}"` : ""}>`;
        default:
          return `<media:${item.kind}>`;
      }
    })
    .join(" ");
}

/** 从 InboundMediaContext 构建上下文的媒体字段 */
export function buildMediaContextFields(media?: InboundMediaContext): Record<string, unknown> {
  if (!media || media.items.length === 0) {
    return {};
  }

  const primary = media.primary ?? media.items[0];

  // 基础字段（兼容旧逻辑，使用主媒体）
  const baseFields: Record<string, unknown> = {
    MediaPath: primary.path,
    MediaType: primary.contentType,
    MediaUrl: primary.path,
  };

  // 多媒体字段（与 Telegram 保持一致的命名）
  // 即使只有一个媒体也添加这些字段，保持一致性
  if (media.items.length > 0) {
    baseFields.MediaPaths = media.items.map((m) => m.path);
    baseFields.MediaUrls = media.items.map((m) => m.path);
    baseFields.MediaTypes = media.items.map((m) => m.contentType).filter(Boolean);
  }

  // 根据主媒体类型添加特定字段
  if (primary.kind === "audio" || primary.kind === "video") {
    if (primary.duration !== undefined) {
      baseFields.MediaDuration = primary.duration;
    }
  }

  if (primary.kind === "file") {
    if (primary.fileName) {
      baseFields.MediaFileName = primary.fileName;
    }
    if (primary.fileSize !== undefined) {
      baseFields.MediaFileSize = primary.fileSize;
    }
  }

  return baseFields;
}

// ============================================================================
// 媒体下载与保存
// ============================================================================

/** 媒体下载保存选项 */
export interface DownloadMediaOptions {
  /** 下载码 */
  downloadCode: string;
  /** 账户配置 */
  account: ResolvedDingTalkAccount;
  /** 媒体类型（用于日志） */
  mediaKind: MediaKind;
  /** 文件扩展名（可选，用于确定 MIME 和文件后缀） */
  extension?: string;
  /** 原始文件名（可选，用于保存时保留后缀） */
  fileName?: string;
  /** 强制指定的 contentType */
  contentType?: string;
}

/** 媒体下载保存结果 */
export interface DownloadMediaResult {
  path: string;
  contentType: string;
  fileSize: number;
}

/**
 * 下载钉钉媒体文件并保存到本地（通用函数）
 * 失败时直接抛出错误，错误消息可直接展示给用户
 */
export async function downloadAndSaveMedia(
  options: DownloadMediaOptions
): Promise<DownloadMediaResult> {
  const { downloadCode, account, mediaKind, fileName } = options;
  const pluginRuntime = getDingTalkRuntime();

  const kindLabel = {
    picture: "图片",
    audio: "语音",
    video: "视频",
    file: "文件",
  }[mediaKind];

  // 1. 获取下载链接
  const downloadUrl = await getFileDownloadUrl(downloadCode, account);
  logger.log(`获取${kindLabel}下载链接成功`);

  // 2. 下载文件
  const buffer = await downloadFromUrl(downloadUrl);
  const sizeStr = buffer.length > 1024 * 1024
    ? `${(buffer.length / 1024 / 1024).toFixed(2)} MB`
    : `${(buffer.length / 1024).toFixed(2)} KB`;
  logger.log(`下载${kindLabel}成功，大小: ${sizeStr}`);

  // 3. 使用 OpenClaw 的 media 工具保存，让 OpenClaw 自己处理文件名和后缀
  const saved = await pluginRuntime.channel.media.saveMediaBuffer(
    buffer,
    undefined, // contentType: 让 OpenClaw 自动检测
    "inbound",
    buffer.length, // maxBytes: 使用实际大小，避免默认 5MB 限制
    fileName // originalFilename: 直接传原始文件名
  );

  logger.log(`${kindLabel}已保存到: ${saved.path}`);
  return {
    path: saved.path,
    contentType: saved.contentType ?? "application/octet-stream",
    fileSize: buffer.length,
  };
}

/** 提取错误消息（不含堆栈） */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
