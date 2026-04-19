/**
 * Write built-in stickers to cache on startup.
 *
 * Called once in index.ts register().
 * Builtin entries are only written when not yet cached; they won't overwrite user received data.
 */

import builtinStickers from "./builtin-stickers.json" with { type: "json" };
import { cacheStickers } from "./sticker-cache.js";
import type { BuiltinStickerJsonEntry } from "./sticker-types.js";

/**
 * Write the built-in sticker list to local cache on process startup.
 * Uses `cacheStickers` for batch write; builtin-sourced entries won't overwrite existing received data.
 */
export function initBuiltinStickers(): void {
  const now = new Date().toISOString();
  const list = builtinStickers as BuiltinStickerJsonEntry[];
  const stickers = list.map((s) => ({
    sticker_id: s.emoji_id,
    package_id: s.emoji_pack_id,
    name: s.name,
    description: s.description?.trim() ? `${s.name} ${s.description.trim()}` : s.name,
    cachedAt: now,
    source: "builtin" as const,
    width: s.width,
    height: s.height,
    formats: s.formats,
  }));
  cacheStickers(stickers);
}
