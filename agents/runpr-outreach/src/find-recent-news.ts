// Find one citable piece of recent news for an agency. Used as the personalization hook.
// Priority order:
//   1. Press releases / news pages from the agency's own domain (last 180 days).
//   2. Industry coverage (PRWeek, O'Dwyer's, Bulldog Reporter) mentioning the agency.
//   3. Generic web mention (last 90 days).

import type { ExaClient } from "./exa-client.js";
import type { RawProspect, RecentNews } from "./types.js";

const NEWS_DOMAINS = [
  "prweek.com",
  "odwyerpr.com",
  "bulldogreporter.com",
  "prnewsonline.com",
  "agencyspy.com",
  "adweek.com",
  "businesswire.com",
  "prnewswire.com",
];

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function findRecentNews(
  exa: ExaClient,
  agency: RawProspect,
): Promise<RecentNews | null> {
  const candidates: RecentNews[] = [];

  // 1. Agency's own press / news / blog content.
  try {
    const resp = await exa.search(`${agency.name} announcement OR launches OR hires OR client`, {
      numResults: 5,
      includeDomains: [agency.domain],
      startPublishedDate: daysAgo(180),
      type: "auto",
      text: { maxCharacters: 600 },
    });
    for (const r of resp.results) {
      if (!r.title) continue;
      candidates.push({
        headline: r.title,
        url: r.url,
        published_at: r.publishedDate,
        snippet: (r.text ?? "").slice(0, 300),
      });
    }
  } catch (err) {
    console.error(`[find-recent-news] own-domain query failed for ${agency.name}`);
  }

  // 2. Trade publications. Stronger signal if a trade picked up the news.
  try {
    const resp = await exa.search(`"${agency.name}"`, {
      numResults: 5,
      includeDomains: NEWS_DOMAINS,
      startPublishedDate: daysAgo(180),
      type: "keyword",
      text: { maxCharacters: 600 },
    });
    for (const r of resp.results) {
      if (!r.title) continue;
      candidates.push({
        headline: r.title,
        url: r.url,
        published_at: r.publishedDate,
        snippet: (r.text ?? "").slice(0, 300),
      });
    }
  } catch (err) {
    // Non-fatal.
  }

  // 3. Generic web fallback.
  if (candidates.length === 0) {
    try {
      const resp = await exa.search(`${agency.name} PR agency`, {
        numResults: 3,
        startPublishedDate: daysAgo(365),
        type: "auto",
        text: { maxCharacters: 600 },
      });
      for (const r of resp.results) {
        if (!r.title) continue;
        candidates.push({
          headline: r.title,
          url: r.url,
          published_at: r.publishedDate,
          snippet: (r.text ?? "").slice(0, 300),
        });
      }
    } catch (err) {
      // Non-fatal.
    }
  }

  if (candidates.length === 0) return null;

  // Prefer the most recent. Exa returns ISO dates when it has them.
  candidates.sort((a, b) => {
    const da = a.published_at ? Date.parse(a.published_at) : 0;
    const db = b.published_at ? Date.parse(b.published_at) : 0;
    return db - da;
  });

  return candidates[0]!;
}
