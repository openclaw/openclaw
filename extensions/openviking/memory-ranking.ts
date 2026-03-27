import type { FindResultItem } from "./client.js";

export function clampScore(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeDedupeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function isEventOrCaseMemory(item: FindResultItem): boolean {
  const category = (item.category ?? "").toLowerCase();
  const uri = item.uri.toLowerCase();
  return (
    category === "events" ||
    category === "cases" ||
    uri.includes("/events/") ||
    uri.includes("/cases/")
  );
}

function getMemoryDedupeKey(item: FindResultItem): string {
  const abstract = normalizeDedupeText(item.abstract ?? item.overview ?? "");
  const category = (item.category ?? "").toLowerCase() || "unknown";
  if (abstract && !isEventOrCaseMemory(item)) {
    return `abstract:${category}:${abstract}`;
  }
  return `uri:${item.uri}`;
}

export function postProcessMemories(
  items: FindResultItem[],
  options: {
    limit: number;
    scoreThreshold: number;
    leafOnly?: boolean;
  },
): FindResultItem[] {
  const deduped: FindResultItem[] = [];
  const seen = new Set<string>();
  const sorted = [...items].sort((a, b) => clampScore(b.score) - clampScore(a.score));
  for (const item of sorted) {
    if (options.leafOnly && item.level !== 2) {
      continue;
    }
    if (clampScore(item.score) < options.scoreThreshold) {
      continue;
    }
    const key = getMemoryDedupeKey(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= options.limit) {
      break;
    }
  }
  return deduped;
}

export function formatMemoryLines(items: FindResultItem[]): string {
  return items
    .map((item, index) => {
      const score = clampScore(item.score);
      const abstract = item.abstract?.trim() || item.overview?.trim() || item.uri;
      const category = item.category ?? "memory";
      return `${index + 1}. [${category}] ${abstract} (${(score * 100).toFixed(0)}%)`;
    })
    .join("\n");
}

export function trimForLog(value: string, limit = 260): string {
  const normalized = value.trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}...`;
}

export function toJsonLog(value: unknown, maxLen = 6000): string {
  try {
    const json = JSON.stringify(value);
    if (json.length <= maxLen) {
      return json;
    }
    return JSON.stringify({
      truncated: true,
      length: json.length,
      preview: `${json.slice(0, maxLen)}...`,
    });
  } catch {
    return JSON.stringify({ error: "stringify_failed" });
  }
}

export function summarizeInjectionMemories(items: FindResultItem[]): Array<Record<string, unknown>> {
  return items.map((item) => ({
    uri: item.uri,
    category: item.category ?? null,
    abstract: trimForLog(item.abstract?.trim() || item.overview?.trim() || item.uri, 180),
    score: clampScore(item.score),
    is_leaf: item.level === 2,
  }));
}

export function summarizeExtractedMemories(
  items: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return items.slice(0, 10).map((item) => {
    const abstractRaw =
      typeof item.abstract === "string"
        ? item.abstract
        : typeof item.overview === "string"
          ? item.overview
          : typeof item.title === "string"
            ? item.title
            : "";
    return {
      uri: typeof item.uri === "string" ? item.uri : null,
      category: typeof item.category === "string" ? item.category : null,
      abstract: trimForLog(abstractRaw, 180),
      is_leaf: item.level === 2,
    };
  });
}

function isPreferencesMemory(item: FindResultItem): boolean {
  return (
    item.category === "preferences" ||
    item.uri.includes("/preferences/") ||
    item.uri.endsWith("/preferences")
  );
}

function isEventMemory(item: FindResultItem): boolean {
  const category = (item.category ?? "").toLowerCase();
  return category === "events" || item.uri.includes("/events/");
}

function isLeafLikeMemory(item: FindResultItem): boolean {
  return item.level === 2;
}

const PREFERENCE_QUERY_RE = /prefer|preference|favorite|favourite|like|偏好|喜欢|爱好|更倾向/i;
const TEMPORAL_QUERY_RE =
  /when|what time|date|day|month|year|yesterday|today|tomorrow|last|next|什么时候|何时|哪天|几月|几年|昨天|今天|明天|上周|下周|上个月|下个月|去年|明年/i;
const QUERY_TOKEN_RE = /[a-z0-9]{2,}/gi;
const QUERY_TOKEN_STOPWORDS = new Set([
  "what",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "whose",
  "why",
  "how",
  "did",
  "does",
  "is",
  "are",
  "was",
  "were",
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "your",
  "you",
]);

type RecallQueryProfile = {
  tokens: string[];
  wantsPreference: boolean;
  wantsTemporal: boolean;
};

function buildRecallQueryProfile(query: string): RecallQueryProfile {
  const text = query.trim();
  const allTokens = text.toLowerCase().match(QUERY_TOKEN_RE) ?? [];
  const tokens = allTokens.filter((token) => !QUERY_TOKEN_STOPWORDS.has(token));
  return {
    tokens,
    wantsPreference: PREFERENCE_QUERY_RE.test(text),
    wantsTemporal: TEMPORAL_QUERY_RE.test(text),
  };
}

function lexicalOverlapBoost(tokens: string[], text: string): number {
  if (tokens.length === 0 || !text) {
    return 0;
  }
  const haystack = ` ${text.toLowerCase()} `;
  let matched = 0;
  for (const token of tokens.slice(0, 8)) {
    if (haystack.includes(` ${token} `) || haystack.includes(token)) {
      matched += 1;
    }
  }
  return Math.min(0.2, (matched / Math.min(tokens.length, 4)) * 0.2);
}

function rankForInjection(item: FindResultItem, query: RecallQueryProfile): number {
  // Keep ranking simple and stable: semantic score + light query-aware boosts.
  const baseScore = clampScore(item.score);
  const abstract = (item.abstract ?? item.overview ?? "").trim();
  const leafBoost = isLeafLikeMemory(item) ? 0.12 : 0;
  const eventBoost = query.wantsTemporal && isEventMemory(item) ? 0.1 : 0;
  const preferenceBoost = query.wantsPreference && isPreferencesMemory(item) ? 0.08 : 0;
  const overlapBoost = lexicalOverlapBoost(query.tokens, `${item.uri} ${abstract}`);
  return baseScore + leafBoost + eventBoost + preferenceBoost + overlapBoost;
}

export function pickMemoriesForInjection(
  items: FindResultItem[],
  limit: number,
  queryText: string,
): FindResultItem[] {
  if (items.length === 0 || limit <= 0) {
    return [];
  }

  const query = buildRecallQueryProfile(queryText);
  const sorted = [...items].sort((a, b) => rankForInjection(b, query) - rankForInjection(a, query));
  const deduped: FindResultItem[] = [];
  const seen = new Set<string>();
  for (const item of sorted) {
    const abstractKey = (item.abstract ?? item.overview ?? "").trim().toLowerCase();
    const key = abstractKey || item.uri;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  const leaves = deduped.filter((item) => isLeafLikeMemory(item));
  if (leaves.length >= limit) {
    return leaves.slice(0, limit);
  }

  const picked = [...leaves];
  const used = new Set(leaves.map((item) => item.uri));
  for (const item of deduped) {
    if (picked.length >= limit) {
      break;
    }
    if (used.has(item.uri)) {
      continue;
    }
    picked.push(item);
  }
  return picked;
}
