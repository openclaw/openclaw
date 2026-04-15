/**
 * 表情包（Sticker）相关类型定义
 */

/** `builtin-stickers.json` 单条（不含 CDN URL、md5、本地路径、状态等易变字段） */
export interface BuiltinStickerJsonEntry {
  emoji_id: string;
  emoji_pack_id: string;
  name: string;
  /** 扩展搜索词条：同义词、口语、英文等，空格分隔；写入缓存的 description */
  description?: string;
  width: number;
  height: number;
  formats: string;
}

export interface CachedSticker {
  /** 表情唯一标识 */
  sticker_id: string;
  /** 表情包 ID */
  package_id: string;
  /** 表情名称 */
  name: string;
  /** 表情Description / 扩展词条（内置来自 JSON；入站可能仅 name） */
  description: string;
  /** 缓存时间（ISO 8601） */
  cachedAt: string;
  /** 来源：内置 or 入站消息中收到 */
  source?: "builtin" | "received";
  /** 像素宽（builtin 或完整入站数据） */
  width?: number;
  /** 像素高 */
  height?: number;
  /** 资源格式，如 png */
  formats?: string;
}

export interface StickerCache {
  /** 缓存格式版本 */
  version: number;
  /** sticker_id → CachedSticker 映射 */
  stickers: Record<string, CachedSticker>;
}
