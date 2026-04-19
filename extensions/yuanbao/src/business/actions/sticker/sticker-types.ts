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
  /** Sticker unique ID */
  sticker_id: string;
  /** Sticker pack ID */
  package_id: string;
  /** Sticker name */
  name: string;
  /** Sticker description / extended terms (builtin from JSON; inbound may only have name) */
  description: string;
  /** Cache time (ISO 8601) */
  cachedAt: string;
  /** Source: builtin or received from inbound message */
  source?: "builtin" | "received";
  /** Pixel width (builtin or full inbound data) */
  width?: number;
  /** Pixel height */
  height?: number;
  /** Resource format, e.g. png */
  formats?: string;
}

export interface StickerCache {
  /** Cache format version */
  version: number;
  /** sticker_id → CachedSticker mapping */
  stickers: Record<string, CachedSticker>;
}
