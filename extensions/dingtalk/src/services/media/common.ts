/**
 * 媒体处理公共工具和常量
 */

// ============ 常量 ============

/** 文本文件扩展名 */
export const TEXT_FILE_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".ts",
  ".py",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".sh",
  ".bat",
  ".csv",
]);

/** 图片文件扩展名 */
export const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|gif|bmp|webp|tiff|svg)$/i;

/** 本地图片路径正则表达式（跨平台） */
export const LOCAL_IMAGE_RE =
  /!\[([^\]]*)\]\(((?:file:\/\/\/|MEDIA:|attachment:\/\/\/)[^)]+|\/(?:tmp|var|private|Users|home|root)[^)]+|[A-Za-z]:[\\/][^)]+)\)/g;

/** 纯文本图片路径正则表达式 */
export const BARE_IMAGE_PATH_RE =
  /`?((?:\/(?:tmp|var|private|Users|home|root)\/[^\s`'",)]+|[A-Za-z]:[\\/][^\s`'",)]+)\.(?:png|jpg|jpeg|gif|bmp|webp))`?/gi;

/** 视频标记正则表达式 */
export const VIDEO_MARKER_PATTERN = /\[DINGTALK_VIDEO\](.*?)\[\/DINGTALK_VIDEO\]/gs;

/** 音频标记正则表达式 */
export const AUDIO_MARKER_PATTERN = /\[DINGTALK_AUDIO\](.*?)\[\/DINGTALK_AUDIO\]/gs;

/** 文件标记正则表达式 */
export const FILE_MARKER_PATTERN = /\[DINGTALK_FILE\](.*?)\[\/DINGTALK_FILE\]/gs;

// ============ 工具函数 ============

/**
 * 去掉 file:// / MEDIA: / attachment:// 前缀，得到实际的绝对路径
 */
export function toLocalPath(raw: string): string {
  let filePath = raw;
  if (filePath.startsWith("file://")) filePath = filePath.replace("file://", "");
  else if (filePath.startsWith("MEDIA:")) filePath = filePath.replace("MEDIA:", "");
  else if (filePath.startsWith("attachment://")) filePath = filePath.replace("attachment://", "");

  try {
    filePath = decodeURIComponent(filePath);
  } catch {
    // 解码失败则保持原样
  }
  return filePath;
}

export { uploadMediaToDingTalk } from "../media.ts";
export type { UploadResult } from "../media.ts";
