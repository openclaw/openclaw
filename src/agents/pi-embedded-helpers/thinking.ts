import { normalizeThinkLevel, type ThinkLevel } from "../../auto-reply/thinking.js";

const FALLBACK_THINKING_CACHE_TTL_MS = 6 * 60 * 60_000;
const FALLBACK_THINKING_CACHE_MAX = 256;

type CachedFallbackThinking = {
  level: ThinkLevel;
  updatedAt: number;
};

const fallbackThinkingCache = new Map<string, CachedFallbackThinking>();

function extractSupportedValues(raw: string): string[] {
  const match =
    raw.match(/supported values are:\s*([^\n.]+)/i) ?? raw.match(/supported values:\s*([^\n.]+)/i);
  if (!match?.[1]) {
    return [];
  }
  const fragment = match[1];
  const quoted = Array.from(fragment.matchAll(/['"]([^'"]+)['"]/g)).map((entry) =>
    entry[1]?.trim(),
  );
  if (quoted.length > 0) {
    return quoted.filter((entry): entry is string => Boolean(entry));
  }
  return fragment
    .split(/,|\band\b/gi)
    .map((entry) => entry.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, "").trim())
    .filter(Boolean);
}

export function pickFallbackThinkingLevel(params: {
  message?: string;
  attempted: Set<ThinkLevel>;
}): ThinkLevel | undefined {
  return pickFallbackThinkingLevelFromMessage(params);
}

function pickFallbackThinkingLevelFromMessage(params: {
  message?: string;
  attempted: Set<ThinkLevel>;
}): ThinkLevel | undefined {
  const raw = params.message?.trim();
  if (!raw) {
    return undefined;
  }
  const supported = extractSupportedValues(raw);
  if (supported.length === 0) {
    // When the error clearly indicates the thinking level is unsupported but doesn't
    // list supported values (e.g. OpenAI's "think value \"low\" is not supported for
    // this model"), fall back to "off" to allow the request to succeed.
    // This commonly happens during model fallback when switching from Anthropic
    // (which supports thinking levels) to providers that don't.
    if (/not supported/i.test(raw) && !params.attempted.has("off")) {
      return "off";
    }
    return undefined;
  }
  for (const entry of supported) {
    const normalized = normalizeThinkLevel(entry);
    if (!normalized) {
      continue;
    }
    if (params.attempted.has(normalized)) {
      continue;
    }
    return normalized;
  }
  return undefined;
}

function buildFallbackThinkingCacheKey(params: {
  provider?: string;
  model?: string;
}): string | null {
  const provider = params.provider?.trim().toLowerCase();
  const model = params.model?.trim().toLowerCase();
  if (!provider || !model) {
    return null;
  }
  return `${provider}/${model}`;
}

function isUnsupportedThinkingMessage(raw: string): boolean {
  return /supported values|not supported/i.test(raw);
}

function pruneFallbackThinkingCache(now: number) {
  const cutoff = now - FALLBACK_THINKING_CACHE_TTL_MS;
  for (const [key, entry] of fallbackThinkingCache) {
    if (entry.updatedAt < cutoff) {
      fallbackThinkingCache.delete(key);
    }
  }
  while (fallbackThinkingCache.size > FALLBACK_THINKING_CACHE_MAX) {
    const oldestKey = fallbackThinkingCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    fallbackThinkingCache.delete(oldestKey);
  }
}

export function pickFallbackThinkingLevelWithCache(params: {
  message?: string;
  attempted: Set<ThinkLevel>;
  provider?: string;
  model?: string;
  nowMs?: number;
}): { level?: ThinkLevel; source?: "cache" | "parsed" } {
  const raw = params.message?.trim();
  if (!raw || !isUnsupportedThinkingMessage(raw)) {
    return {};
  }
  const now = params.nowMs ?? Date.now();
  const cacheKey = buildFallbackThinkingCacheKey(params);
  if (cacheKey) {
    pruneFallbackThinkingCache(now);
    const cached = fallbackThinkingCache.get(cacheKey);
    if (cached && now - cached.updatedAt < FALLBACK_THINKING_CACHE_TTL_MS) {
      if (!params.attempted.has(cached.level)) {
        fallbackThinkingCache.delete(cacheKey);
        fallbackThinkingCache.set(cacheKey, { ...cached, updatedAt: now });
        return { level: cached.level, source: "cache" };
      }
    }
  }

  const parsed = pickFallbackThinkingLevelFromMessage({
    message: raw,
    attempted: params.attempted,
  });
  if (!parsed) {
    return {};
  }
  if (cacheKey) {
    fallbackThinkingCache.delete(cacheKey);
    fallbackThinkingCache.set(cacheKey, { level: parsed, updatedAt: now });
    pruneFallbackThinkingCache(now);
  }
  return { level: parsed, source: "parsed" };
}

export function resetFallbackThinkingCacheForTests() {
  fallbackThinkingCache.clear();
}
