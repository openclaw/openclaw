import type { Article, SourceConfig } from "../../types.js";
import { scrapeAllRss } from "./rss.js";

export interface ScrapeOpts {
  /** Final pool size after balancing (default 30) */
  poolSize?: number;
  /** Max articles per source after dedup (default 3) */
  maxPerSource?: number;
}

/**
 * Cap each source's contribution to the pool. Within a source we keep the
 * top-scoring entries (ties broken by recency), so the strongest signal per
 * outlet survives.
 */
export function capPerSource(articles: Article[], maxPerSource: number): Article[] {
  const bySource = new Map<string, Article[]>();
  for (const a of articles) {
    const list = bySource.get(a.source) ?? [];
    list.push(a);
    bySource.set(a.source, list);
  }
  const balanced: Article[] = [];
  for (const [, list] of bySource) {
    list.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.published.getTime() - a.published.getTime();
    });
    balanced.push(...list.slice(0, maxPerSource));
  }
  return balanced;
}

export async function scrapeAll(
  sources: SourceConfig[],
  opts: ScrapeOpts = {},
): Promise<Article[]> {
  const poolSize = opts.poolSize ?? 30;
  const maxPerSource = opts.maxPerSource ?? 3;

  console.log("\n📡 Stage 1: Scraping tech news...");

  // RSS only — daily.dev Playwright scrape was dropped in the candidate-pool refactor
  const rssArticles = await scrapeAllRss(sources);

  // Deduplicate by URL
  const seen = new Set<string>();
  const unique = rssArticles.filter((a) => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });

  // Per-source cap → balance the pool so no single source dominates
  const balanced = capPerSource(unique, maxPerSource);

  // Global sort by score → recency
  balanced.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.published.getTime() - a.published.getTime();
  });

  const pool = balanced.slice(0, poolSize);

  const sourceCount = new Set(pool.map((a) => a.source)).size;
  console.log(`  Pool: ${pool.length} articles from ${sourceCount} sources\n`);
  return pool;
}
