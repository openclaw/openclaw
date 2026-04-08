/**
 * Pure filtering helpers for Step 3 (related sources).
 *
 * No IO or HTTP — just keyword overlap math against the candidate pool.
 */
import type { Article, SelectedConcept } from "../../types.js";

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Words that are too generic to match on individually. */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "in",
  "on",
  "for",
  "to",
  "is",
  "at",
  "by",
  "with",
  "from",
  "as",
  "that",
  "this",
  "it",
  "its",
  "be",
  "are",
  "was",
]);

/**
 * Expand a caller-provided keyword list into the set of tokens we actually
 * search against. Handles multi-word keywords like "data centers in space"
 * by splitting into individual tokens and dropping stopwords + short words.
 *
 * Returns a deduped array of lowercase tokens (each ≥ 3 chars, non-stopword).
 * The original phrase is also included so exact matches still count.
 */
export function expandKeywords(keywords: string[]): string[] {
  const set = new Set<string>();
  for (const kw of keywords) {
    const norm = kw.trim().toLowerCase();
    if (!norm) continue;
    // Keep the full phrase (useful if the LLM did emit a specific phrase
    // that happens to appear verbatim in a headline)
    set.add(norm);
    // Expand into individual tokens
    for (const token of norm.split(/\s+/)) {
      if (token.length >= 3 && !STOPWORDS.has(token)) {
        set.add(token);
      }
    }
  }
  return [...set];
}

/**
 * Count how many tokens from `keywords` appear in the article's title + summary.
 *
 * Multi-word keywords are automatically expanded into their individual non-stopword
 * tokens, so a keyword like "data centers in space" contributes four match
 * opportunities: "data centers in space" (full phrase), "data", "centers", "space".
 *
 * Whole-token matching (`\b...\b`) so "ai" matches "ai launches" and "openai"
 * but NOT "main" or "fail". Case-insensitive. Returns 0 if nothing matches
 * (or if `keywords` is empty).
 */
export function scoreByKeywords(article: Article, keywords: string[]): number {
  if (!keywords.length) return 0;
  const haystack = `${article.title} ${article.summary}`.toLowerCase();
  const expanded = expandKeywords(keywords);
  let count = 0;
  for (const token of expanded) {
    // Whole-token boundary so "ai" doesn't match "main"
    const re = new RegExp(`\\b${escapeRegExp(token)}\\b`);
    if (re.test(haystack)) count++;
  }
  return count;
}

/**
 * Pick the top related articles for a concept from the candidate pool.
 *
 * Algorithm:
 * 1. Always include `concept.seedArticle` first (anchor).
 * 2. Score the rest of the pool by keyword overlap (drop the seed by URL).
 * 3. Take the top `limit - 1` candidates that have AT LEAST ONE keyword match
 *    (ties broken by article.score desc, then recency desc).
 *
 * We deliberately do NOT pad with zero-overlap articles when the pool is thin
 * — Step 4 wants concept-relevant material, and padding with unrelated articles
 * would waste the script prompt budget on irrelevant text. If the pool only has
 * the seed + 1 related article, the return value has just 2 entries.
 *
 * Returns articles annotated with `keywordMatches` so callers can inspect why
 * each was picked.
 */
export function pickRelated(
  concept: SelectedConcept,
  pool: Article[],
  limit: number,
): Array<{ article: Article; keywordMatches: number }> {
  if (limit <= 0) return [];

  const seedUrl = concept.seedArticle.url;
  const result: Array<{ article: Article; keywordMatches: number }> = [];

  // 1. Seed always first (even if it has 0 keyword matches against its own summary)
  result.push({
    article: concept.seedArticle,
    keywordMatches: scoreByKeywords(concept.seedArticle, concept.keywords),
  });

  if (limit === 1) return result;

  // 2. Score the rest of the pool, keep only those with at least one keyword match
  const others = pool
    .filter((a) => a.url !== seedUrl)
    .map((article) => ({
      article,
      keywordMatches: scoreByKeywords(article, concept.keywords),
    }))
    .filter((entry) => entry.keywordMatches > 0);

  // Sort: keyword matches desc → article.score desc → recency desc
  others.sort((a, b) => {
    if (b.keywordMatches !== a.keywordMatches) return b.keywordMatches - a.keywordMatches;
    if (b.article.score !== a.article.score) return b.article.score - a.article.score;
    return b.article.published.getTime() - a.article.published.getTime();
  });

  // 3. Take up to (limit - 1) concept-relevant articles
  for (const item of others.slice(0, limit - 1)) {
    result.push(item);
  }

  return result;
}
