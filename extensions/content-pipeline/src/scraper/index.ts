import type { Article, SourceConfig } from "../types.js";
import { scrapeDailyDev } from "./dailydev.js";
import { scrapeAllRss } from "./rss.js";

export async function scrapeAll(sources: SourceConfig[]): Promise<Article[]> {
  console.log("\n📡 Stage 1: Scraping tech news...");

  const scrapeSources = sources.filter((s) => s.type === "scrape");

  // Run RSS and scrape sources concurrently
  const [rssArticles, ...scrapeResults] = await Promise.all([
    scrapeAllRss(sources),
    ...scrapeSources.map((s) => scrapeDailyDev(s)),
  ]);

  const allArticles = [...rssArticles, ...scrapeResults.flat()];

  // Deduplicate by URL
  const seen = new Set<string>();
  const unique = allArticles.filter((a) => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });

  // Sort by score (desc), then by recency (desc)
  unique.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.published.getTime() - a.published.getTime();
  });

  console.log(`  Total: ${unique.length} unique articles\n`);
  return unique;
}
