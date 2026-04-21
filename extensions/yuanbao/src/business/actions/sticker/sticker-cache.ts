import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CachedSticker, StickerCache } from "./sticker-types.js";

function getCacheFilePath(): string {
  return join(homedir(), ".openclaw", "state", "yuanbao", "sticker-cache.json");
}

const CURRENT_VERSION = 1;

function loadCache(): StickerCache {
  const filePath = getCacheFilePath();
  if (!existsSync(filePath)) {
    return { version: CURRENT_VERSION, stickers: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<StickerCache>;
    const stickers =
      parsed.stickers && typeof parsed.stickers === "object" && !Array.isArray(parsed.stickers)
        ? parsed.stickers
        : {};
    return {
      version: typeof parsed.version === "number" ? parsed.version : CURRENT_VERSION,
      stickers,
    };
  } catch {
    return { version: CURRENT_VERSION, stickers: {} };
  }
}

export function getCachedSticker(stickerId: string): CachedSticker | undefined {
  return loadCache().stickers[stickerId];
}

function norm(s: string): string {
  return (s ?? "").normalize("NFKC").trim().toLowerCase();
}

function compact(s: string): string {
  return norm(s).replace(/[\s\u3000\-_·.,，。!！?？"""'''、/\\]+/g, "");
}

function charOverlap(needle: string, hay: string): number {
  if (!needle.length) {
    return 0;
  }
  const bag = new Map<string, number>();
  for (const ch of hay) {
    bag.set(ch, (bag.get(ch) ?? 0) + 1);
  }
  let hits = 0;
  for (const ch of needle) {
    const n = bag.get(ch) ?? 0;
    if (n > 0) {
      hits++;
      bag.set(ch, n - 1);
    }
  }
  return hits / needle.length;
}

function scoreField(haystack: string, query: string): number {
  const h = norm(haystack),
    q = norm(query);
  if (!h || !q) {
    return 0;
  }
  const hC = compact(haystack),
    qC = compact(query);
  if (h === q) {
    return 100;
  }
  if (h.includes(q)) {
    return 92 + Math.min(6, q.length);
  }
  if (q.length >= 2 && h.startsWith(q)) {
    return 88;
  }
  if (qC.length > 0 && hC.includes(qC)) {
    return 86;
  }
  if (q.length === 1 && h.includes(q)) {
    return 68;
  }
  return charOverlap(qC, hC) * 62;
}

function scoreText(haystack: string, rawQuery: string): number {
  const full = scoreField(haystack, rawQuery);
  const tokens = norm(rawQuery).split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) {
    return full;
  }
  const parts = tokens.map((t) => scoreField(haystack, t));
  const mean = parts.reduce((a, b) => a + b, 0) / parts.length;
  return Math.max(full, Math.min(...parts) * 0.35 + mean * 0.65);
}

export function searchStickers(query: string, limit = 10): CachedSticker[] {
  const cache = loadCache();
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit) || 10));
  const q = norm(query);
  if (!q) {
    return Object.values(cache.stickers).slice(0, safeLimit);
  }

  const scored: Array<{ sticker: CachedSticker; score: number }> = [];
  for (const sticker of Object.values(cache.stickers)) {
    const nameS = scoreText(sticker.name ?? "", query);
    const descS = scoreText(sticker.description ?? "", query) * 0.88;
    const idNorm = norm(sticker.sticker_id ?? "");
    const idS = idNorm === q ? 100 : idNorm.includes(q) ? 84 : 0;
    scored.push({ sticker, score: Math.max(nameS, descS, idS) });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]?.score ?? 0;
  if (top <= 0) {
    return Object.values(cache.stickers).slice(0, safeLimit);
  }
  const floor = top >= 22 ? 18 : top >= 12 ? Math.max(10, top * 0.5) : Math.max(6, top * 0.35);
  const filtered = scored.filter((s) => s.score >= floor);
  return (filtered.length > 0 ? filtered : scored).slice(0, safeLimit).map((s) => s.sticker);
}
