import path from "node:path";

export const MAX_CONCEPT_TAGS = 8;

const CONCEPT_TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9._/-]{2,}/g;

const SHARED_CONCEPT_STOP_WORDS = [
  "about",
  "after",
  "agent",
  "again",
  "also",
  "because",
  "before",
  "being",
  "between",
  "build",
  "called",
  "could",
  "daily",
  "default",
  "deploy",
  "during",
  "every",
  "file",
  "files",
  "from",
  "have",
  "into",
  "just",
  "line",
  "lines",
  "long",
  "main",
  "make",
  "memory",
  "month",
  "more",
  "most",
  "move",
  "much",
  "next",
  "note",
  "notes",
  "over",
  "part",
  "past",
  "port",
  "same",
  "score",
  "search",
  "session",
  "sessions",
  "short",
  "should",
  "since",
  "some",
  "than",
  "that",
  "their",
  "there",
  "these",
  "they",
  "this",
  "through",
  "today",
  "using",
  "with",
  "work",
  "workspace",
  "year",
] as const;

const CONCEPT_PATH_NOISE_WORDS = [
  "cjs",
  "cts",
  "jsx",
  "json",
  "md",
  "mjs",
  "mts",
  "text",
  "toml",
  "ts",
  "tsx",
  "txt",
  "yaml",
  "yml",
] as const;

const CONCEPT_STOP_WORDS = new Set([...SHARED_CONCEPT_STOP_WORDS, ...CONCEPT_PATH_NOISE_WORDS]);

function normalizeConceptToken(rawToken: string): string | null {
  const normalized = rawToken
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .replaceAll("_", "-")
    .toLowerCase();
  if (!normalized || normalized.length < 3 || normalized.length > 32) {
    return null;
  }
  if (/^\d+$/.test(normalized) || /^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return null;
  }
  if (CONCEPT_STOP_WORDS.has(normalized)) {
    return null;
  }
  return normalized;
}

export function deriveConceptTags(params: {
  path: string;
  snippet: string;
  limit?: number;
}): string[] {
  const source = `${path.basename(params.path)} ${params.snippet}`;
  const limit = Number.isFinite(params.limit)
    ? Math.max(0, Math.floor(params.limit as number))
    : MAX_CONCEPT_TAGS;
  if (limit === 0) {
    return [];
  }
  const tokens = source.match(CONCEPT_TOKEN_RE) ?? [];
  const tags: string[] = [];
  for (const rawToken of tokens) {
    const normalized = normalizeConceptToken(rawToken);
    if (!normalized || tags.includes(normalized)) {
      continue;
    }
    tags.push(normalized);
    if (tags.length >= limit) {
      break;
    }
  }
  return tags;
}

export const __testing = {
  normalizeConceptToken,
};
