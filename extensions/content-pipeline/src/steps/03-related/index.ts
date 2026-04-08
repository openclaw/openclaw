/**
 * Step 3 — Related sources.
 *
 * Picks the articles in the candidate pool that cover the same concept (by
 * keyword overlap) and fetches their full HTML body via cheerio so Step 4 has
 * real material to draw quotes / numbers / context from.
 *
 * Pure logic (filter + extractor) lives in `./filter.ts` and `./fetch.ts`,
 * tested without the network. This file is the orchestrator.
 */
import type { Article, FullArticle, PipelineConfig, SelectedConcept } from "../../types.js";
import { fetchFullText } from "./fetch.js";
import { pickRelated } from "./filter.js";

export interface FindRelatedOpts {
  /** Override default limit from contentConfig.relatedSources */
  limit?: number;
  /** Override default char cap from contentConfig.maxFullTextChars */
  maxChars?: number;
}

/**
 * Pick related articles from the pool for the given concept and fetch their
 * full body text in parallel.
 *
 * Returns FullArticle[] with the seed always at index 0. Failed fetches are
 * still returned (with `fetchOk: false`) so callers can decide what to do.
 */
export async function findRelatedSources(
  concept: SelectedConcept,
  pool: Article[],
  contentConfig: PipelineConfig["content"],
  opts: FindRelatedOpts = {},
): Promise<FullArticle[]> {
  const limit = opts.limit ?? contentConfig.relatedSources ?? 5;
  const maxChars = opts.maxChars ?? contentConfig.maxFullTextChars ?? 3000;

  console.log(`📚 Stage 1.6: Finding ${limit} related sources for "${concept.title}"...`);

  const picks = pickRelated(concept, pool, limit);
  if (picks.length === 0) {
    return [];
  }

  // Fetch all in parallel — limit is small (default 5) so unbounded is fine
  const fetched = await Promise.all(
    picks.map(async ({ article, keywordMatches }) => {
      const result = await fetchFullText(article, maxChars);
      // Re-stamp keywordMatches from the picker (fetchFullText resets it to 0)
      return { ...result, keywordMatches };
    }),
  );

  const ok = fetched.filter((f) => f.fetchOk).length;
  console.log(`  ✓ ${ok}/${fetched.length} related sources fetched`);
  return fetched;
}
