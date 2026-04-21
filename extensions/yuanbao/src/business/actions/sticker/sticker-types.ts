export interface CachedSticker {
  sticker_id: string;
  package_id: string;
  name: string;
  description: string;
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
