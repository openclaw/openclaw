import { chromium, type Browser } from "playwright";
import type { Article, SourceConfig } from "../types.js";

export async function scrapeDailyDev(source: SourceConfig): Promise<Article[]> {
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(source.url, { waitUntil: "networkidle", timeout: 30_000 });

    // Wait for feed cards to render
    await page
      .waitForSelector("article, [data-testid='post-card']", { timeout: 10_000 })
      .catch(() => {
        // Fallback: wait for any link-like content
      });

    // Extract articles from the feed
    const articles = await page.evaluate((maxItems: number) => {
      const cards = document.querySelectorAll(
        "article, [data-testid='post-card'], a[href*='/posts/']",
      );
      const results: Array<{ title: string; url: string; score: number }> = [];

      for (const card of Array.from(cards).slice(0, maxItems)) {
        const titleEl = card.querySelector("h2, h3, [class*='title']");
        const linkEl = card.closest("a") ?? card.querySelector("a");
        const upvoteEl = card.querySelector("[class*='upvote'], [class*='vote']");

        const title = titleEl?.textContent?.trim() ?? "";
        const url = linkEl?.getAttribute("href") ?? "";
        const scoreText = upvoteEl?.textContent?.trim() ?? "0";
        const score = parseInt(scoreText, 10) || 0;

        if (title && url) {
          results.push({
            title,
            url: url.startsWith("http") ? url : `https://app.daily.dev${url}`,
            score,
          });
        }
      }

      return results;
    }, source.maxItems);

    const result: Article[] = articles.map((a) => ({
      title: a.title,
      url: a.url,
      source: "daily.dev",
      summary: "",
      score: a.score,
      published: new Date(),
    }));

    console.log(`  ✓ daily.dev: ${result.length} articles`);
    return result;
  } catch (err) {
    console.error(`  ✗ daily.dev: ${(err as Error).message}`);
    return [];
  } finally {
    await browser?.close();
  }
}
