/**
 * Sticker-related type definitions.
 */

/** Single entry from `builtin-stickers.json` (excludes volatile fields like CDN URL, md5, local path, status) */
export interface BuiltinStickerJsonEntry {
  emoji_id: string;
  emoji_pack_id: string;
  name: string;
  /** Extended search terms: synonyms, colloquial, English, etc., space-separated; written to cache description */
  description?: string;
  width: number;
  height: number;
  formats: string;
}

export interface CachedSticker {
  sticker_id: string;
  package_id: string;
  name: string;
  /** Builtin from JSON; inbound may only have name */
  description: string;
  /** ISO 8601 */
  cachedAt: string;
  source?: "builtin" | "received";
  width?: number;
  height?: number;
  /** e.g. png */
  formats?: string;
}

export interface StickerCache {
  version: number;
  stickers: Record<string, CachedSticker>;
}
