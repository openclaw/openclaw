/**
 * Sticker cache read/write and search
 *
 * 存储路径：~/.openclaw/state/yuanbao/sticker-cache.json
 * 使用 node:fs + node:os，不依赖 SDK 工具。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CachedSticker, StickerCache } from "./sticker-types.js";

// ============ 路径计算 ============

function getCacheFilePath(): string {
  return join(homedir(), ".openclaw", "state", "yuanbao", "sticker-cache.json");
}

function ensureCacheDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function asStickersRecord(value: unknown): StickerCache["stickers"] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as StickerCache["stickers"];
  }
  return {};
}

// ============ 读写 ============

const CURRENT_VERSION = 1;

/**
 * 从磁盘加载表情缓存；文件不存在或 JSON 损坏时返回空结构，避免阻塞调用方。
 *
 * @returns 当前缓存对象（含 `version` 与 `stickers` 映射）
 */
export function loadCache(): StickerCache {
  const filePath = getCacheFilePath();
  if (!existsSync(filePath)) {
    return { version: CURRENT_VERSION, stickers: {} };
  }
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<StickerCache>;
    const stickers = asStickersRecord(parsed.stickers);
    return {
      version: typeof parsed.version === "number" ? parsed.version : CURRENT_VERSION,
      stickers,
    };
  } catch {
    return { version: CURRENT_VERSION, stickers: {} };
  }
}

/**
 * Write the complete sticker cache back to disk (creates parent directory).
 *
 * @param cache - 内存中的缓存快照
 */
export function saveCache(cache: StickerCache): void {
  const filePath = getCacheFilePath();
  ensureCacheDir(filePath);
  writeFileSync(filePath, JSON.stringify(cache, null, 2), "utf-8");
}

// ============ 单条操作 ============

/**
 * 缓存单条表情；同 `sticker_id` 已存在则覆盖（与批量接口的 builtin 跳过策略不同）。
 *
 * @param sticker - 待写入的表情元数据
 */
export function cacheSticker(sticker: CachedSticker): void {
  const cache = loadCache();
  cache.stickers[sticker.sticker_id] = sticker;
  saveCache(cache);
}

/**
 * 批量缓存表情。`source: builtin` 不会覆盖 `received`；会覆盖同 id 的旧 builtin（便于内置清单/词条更新）。
 *
 * @param stickers - 待合并写入的表情列表
 */
export function cacheStickers(stickers: CachedSticker[]): void {
  if (stickers.length === 0) {
    return;
  }
  const cache = loadCache();
  for (const sticker of stickers) {
    const existing = cache.stickers[sticker.sticker_id];
    // builtin：不覆盖入站 received；其余情况写入（含用新 builtin 覆盖旧 builtin，便于扩展词条更新）
    if (sticker.source === "builtin" && existing?.source === "received") {
      continue;
    }
    cache.stickers[sticker.sticker_id] = sticker;
  }
  saveCache(cache);
}

/**
 * Read a single cached sticker by primary key.
 *
 * @param stickerId - 表情唯一标识
 * @returns 命中则返回缓存条目，否则 `undefined`
 */
export function getCachedSticker(stickerId: string): CachedSticker | undefined {
  const cache = loadCache();
  return cache.stickers[stickerId];
}

// ============ 搜索 ============

/** 统一大小写/兼容字符，便于中英文混合名匹配 */
function normalizeStickerMatchText(raw: string): string {
  return (raw ?? "").normalize("NFKC").trim().toLowerCase();
}

/** 去掉空白与常见标点，缓解「打 call」vs「打call」、全角空格等不一致 */
function compactStickerMatchText(s: string): string {
  return normalizeStickerMatchText(s).replace(/[\s\u3000\-_·.,，。!！?？"“”'‘’、/\\]+/g, "");
}

function bigramSet(s: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) {
    set.add(s.slice(i, i + 2));
  }
  return set;
}

/** 双字片段 Jaccard，对中文词边界弱、子串未连续命中时有帮助 */
function stickerBigramJaccard(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) {
    return 0;
  }
  const A = bigramSet(a);
  const B = bigramSet(b);
  let inter = 0;
  for (const x of A) {
    if (B.has(x)) {
      inter++;
    }
  }
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** query 字符在 name 中的多重集命中率（重复字需多次命中） */
function multisetCharHitRatio(needleCompact: string, hayCompact: string): number {
  if (!needleCompact.length) {
    return 0;
  }
  const bag = new Map<string, number>();
  for (const ch of hayCompact) {
    bag.set(ch, (bag.get(ch) ?? 0) + 1);
  }
  let hits = 0;
  for (const ch of needleCompact) {
    const n = bag.get(ch) ?? 0;
    if (n > 0) {
      hits++;
      bag.set(ch, n - 1);
    }
  }
  return hits / needleCompact.length;
}

/** needle 作为子序列落在 haystack 中的最长比例 */
function longestSubsequenceRatio(needle: string, haystack: string): number {
  if (!needle.length) {
    return 0;
  }
  let j = 0;
  for (let i = 0; i < haystack.length && j < needle.length; i++) {
    if (haystack[i] === needle[j]) {
      j++;
    }
  }
  return j / needle.length;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) {
    return n;
  }
  if (n === 0) {
    return m;
  }
  const row = Array.from<number>({ length: n + 1 });
  for (let j = 0; j <= n; j++) {
    row[j] = j;
  }
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[n];
}

/** 短纯 ASCII 片段（如 call、ok）与名称中英部分的模糊匹配 */
function asciiFuzzyStickerScore(needleNorm: string, hayNorm: string): number {
  // 仅处理 ASCII 范围内的字符串（排除中文等非 ASCII 字符）
  if (needleNorm.length < 2 || needleNorm.length > 14) {
    return 0;
  }
  if (!needleNorm.split("").every((ch) => ch.charCodeAt(0) <= 0x7f)) {
    return 0;
  }
  const h = hayNorm.replace(/[^a-z0-9]/g, "");
  if (h.length < needleNorm.length - 1 || h.length > 36) {
    return 0;
  }
  const slice = h.length > needleNorm.length + 6 ? h.slice(0, needleNorm.length + 6) : h;
  const d = levenshtein(needleNorm, slice);
  const maxL = Math.max(needleNorm.length, slice.length, 1);
  return Math.max(0, (1 - d / maxL) * 38);
}

/**
 * 单字段与整段 query 的相似度分数（0～100+），兼顾中文子串、字覆盖、双字重合与轻量模糊。
 */
function scoreStickerFieldAgainstQuery(haystack: string, rawQuery: string): number {
  const hay = normalizeStickerMatchText(haystack);
  const q = normalizeStickerMatchText(rawQuery);
  if (!hay || !q) {
    return 0;
  }

  const hayC = compactStickerMatchText(haystack);
  const qC = compactStickerMatchText(rawQuery);

  let best = 0;

  if (hay === q) {
    best = Math.max(best, 100);
  }
  if (hay.includes(q)) {
    best = Math.max(best, 92 + Math.min(6, q.length));
  }
  if (q.length >= 2 && hay.startsWith(q)) {
    best = Math.max(best, 88);
  }
  if (qC.length > 0 && hayC.includes(qC)) {
    best = Math.max(best, 86);
  }

  const charR = multisetCharHitRatio(qC, hayC);
  best = Math.max(best, charR * 62);

  const jac = stickerBigramJaccard(qC, hayC);
  best = Math.max(best, jac * 58);

  const sub = longestSubsequenceRatio(qC, hayC);
  best = Math.max(best, sub * 52);

  best = Math.max(best, asciiFuzzyStickerScore(q, hay));

  if (q.length === 1 && hay.includes(q)) {
    best = Math.max(best, 68);
  }

  return best;
}

function scoreStickerFieldAgainstTokens(haystack: string, tokens: string[]): number {
  if (tokens.length === 0) {
    return 0;
  }
  const parts = tokens.map((t) => scoreStickerFieldAgainstQuery(haystack, t));
  const mean = parts.reduce((a, b) => a + b, 0) / parts.length;
  const weakest = Math.min(...parts);
  return weakest * 0.35 + mean * 0.65;
}

function tokenizeStickerQuery(raw: string): string[] {
  const q = normalizeStickerMatchText(raw);
  return q.split(/\s+/).filter(Boolean);
}

/**
 * 合并「整句」与「分词」得分：多词 query 如「暗中 观察」更易命中「暗中观察」类名称。
 */
function scoreStickerTextAgainstQuery(haystack: string, rawQuery: string): number {
  const full = scoreStickerFieldAgainstQuery(haystack, rawQuery);
  const tokens = tokenizeStickerQuery(rawQuery);
  if (tokens.length <= 1) {
    return full;
  }
  const multi = scoreStickerFieldAgainstTokens(haystack, tokens);
  return Math.max(full, multi);
}

/**
 * Search stickers in cache.
 *
 * 评分要点：规范化（NFKC）与去标点后的子串匹配、中文字符多重集覆盖率、双字 Jaccard、
 * 子序列比例、短 ASCII 的编辑距离；name 权重高于 description，id 用于精确 id 搜索。
 *
 * @param query - 搜索词
 * @param limit - 最多返回条数（Default 10，最大 500）
 * @returns 按分数降序排列的表情列表
 */
export function searchStickers(query: string, limit = 10): CachedSticker[] {
  const cache = loadCache();
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit) || 10));
  const q = normalizeStickerMatchText(query);
  if (!q) {
    return Object.values(cache.stickers).slice(0, safeLimit);
  }

  const scored: Array<{ sticker: CachedSticker; score: number }> = [];

  for (const sticker of Object.values(cache.stickers)) {
    const name = (sticker.name ?? "").trim();
    const desc = (sticker.description ?? "").trim();
    const id = (sticker.sticker_id ?? "").trim();

    const nameS = scoreStickerTextAgainstQuery(name, query);
    const descS = scoreStickerTextAgainstQuery(desc, query) * 0.88;
    const idNorm = normalizeStickerMatchText(id);
    const idQ = normalizeStickerMatchText(query);
    let idS = 0;
    if (id && idQ) {
      if (idNorm === idQ) {
        idS = 100;
      } else if (idNorm.includes(idQ)) {
        idS = 84;
      }
    }

    const score = Math.max(nameS, descS, idS);

    scored.push({ sticker, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]?.score ?? 0;
  if (top <= 0) {
    return Object.values(cache.stickers).slice(0, safeLimit);
  }
  let floor: number;
  if (top >= 22) {
    floor = 18;
  } else if (top >= 12) {
    floor = Math.max(10, top * 0.5);
  } else {
    floor = Math.max(6, top * 0.35);
  }
  const filtered = scored.filter((s) => s.score >= floor);
  const list = filtered.length > 0 ? filtered : scored;
  return list.slice(0, safeLimit).map((s) => s.sticker);
}
