import Parser from "rss-parser";
import type { Article, SourceConfig } from "../../types.js";

const parser = new Parser({
  timeout: 15_000,
  headers: { "User-Agent": "OpenClaw-ContentPipeline/0.1" },
  customFields: {
    item: [["description", "rawDescription"]],
  },
});

export async function fetchRss(source: SourceConfig): Promise<Article[]> {
  try {
    const feed = await parser.parseURL(source.url);
    const articles: Article[] = [];

    for (const item of feed.items.slice(0, source.maxItems)) {
      let score = 0;
      // Extract score from HN/Lobsters — look in raw description HTML
      const rawDesc = (item as unknown as Record<string, string>).rawDescription ?? "";
      const combined = `${rawDesc} ${item.contentSnippet ?? ""}`;
      // Match "N points" but cap at reasonable values (HN IDs are 8+ digits)
      const scoreMatch = combined.match(/(\d{1,5})\s*points?/i);
      if (scoreMatch) score = parseInt(scoreMatch[1], 10);

      const summary = (item.contentSnippet ?? "").slice(0, 500);

      articles.push({
        title: item.title ?? "Untitled",
        url: item.link ?? "",
        source: source.name,
        summary,
        score,
        published: item.pubDate ? new Date(item.pubDate) : new Date(),
      });
    }

    console.log(`  ✓ ${source.name}: ${articles.length} articles`);
    return articles;
  } catch (err) {
    console.error(`  ✗ ${source.name}: ${(err as Error).message}`);
    return [];
  }
}

export async function scrapeAllRss(sources: SourceConfig[]): Promise<Article[]> {
  const rssSources = sources.filter((s) => s.type === "rss");
  const results = await Promise.all(rssSources.map(fetchRss));
  return results.flat();
}
