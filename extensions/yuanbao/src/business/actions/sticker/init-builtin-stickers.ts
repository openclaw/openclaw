/**
 * Write built-in stickers to cache on startup
 *
 * 在 index.ts register() 中调用一次即可。
 * builtin 来源的条目仅在尚未缓存时写入，不会覆盖用户 received 数据。
 */

import builtinStickers from "./builtin-stickers.json" with { type: "json" };
import { cacheStickers } from "./sticker-cache.js";
import type { BuiltinStickerJsonEntry } from "./sticker-types.js";

/**
 * Write the built-in sticker list to local cache on process startup.
 *
 * 通过 `cacheStickers` 批量写入：`source` 为 builtin 的条目不会覆盖已存在的 received 数据。
 *
 * @returns 无；副作用为更新磁盘上的 `sticker-cache.json`
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
