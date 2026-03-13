import type { OpenClawConfig } from "../config/config.js";
export interface CachedSticker {
    fileId: string;
    fileUniqueId: string;
    emoji?: string;
    setName?: string;
    description: string;
    cachedAt: string;
    receivedFrom?: string;
}
/**
 * Get a cached sticker by its unique ID.
 */
export declare function getCachedSticker(fileUniqueId: string): CachedSticker | null;
/**
 * Add or update a sticker in the cache.
 */
export declare function cacheSticker(sticker: CachedSticker): void;
/**
 * Search cached stickers by text query (fuzzy match on description + emoji + setName).
 */
export declare function searchStickers(query: string, limit?: number): CachedSticker[];
/**
 * Get all cached stickers (for debugging/listing).
 */
export declare function getAllCachedStickers(): CachedSticker[];
/**
 * Get cache statistics.
 */
export declare function getCacheStats(): {
    count: number;
    oldestAt?: string;
    newestAt?: string;
};
export interface DescribeStickerParams {
    imagePath: string;
    cfg: OpenClawConfig;
    agentDir?: string;
    agentId?: string;
}
/**
 * Describe a sticker image using vision API.
 * Auto-detects an available vision provider based on configured API keys.
 * Returns null if no vision provider is available.
 */
export declare function describeStickerImage(params: DescribeStickerParams): Promise<string | null>;
