// Source new PR agency prospects via Exa. Targets mid-size US B2B tech PR firms.

import type { ExaClient, ExaResult } from "./exa-client.js";
import type { RawProspect, ContactedFile } from "./types.js";
import { isAlreadyContacted } from "./track-contacted.js";

// Pool of search queries we rotate through. Each run picks 2-3 to keep results diverse.
const QUERY_POOL = [
  "best B2B technology PR agencies United States 2026",
  "mid-size B2B SaaS PR agency client list",
  "boutique tech PR firm fintech cybersecurity client roster",
  "technology PR agency series B startup clients",
  "AI PR agency United States enterprise tech",
  "B2B tech communications agency healthcare technology",
  "enterprise software PR firm developer tools clients",
];

const BLOCKED_DOMAINS = new Set([
  "linkedin.com",
  "indeed.com",
  "glassdoor.com",
  "ziprecruiter.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "wikipedia.org",
  "g2.com",
  "capterra.com",
  "reddit.com",
  "youtube.com",
  "medium.com",
  "substack.com",
  "clutch.co",
  "agencyspotter.com",
  "designrush.com",
  "ranked.com",
  "sortlist.com",
  "expertise.com",
  "upcity.com",
  "muckrack.com",
  "cision.com",
  "meltwater.com",
  "prnewswire.com",
  "businesswire.com",
  "globenewswire.com",
  "prweek.com",
  "prnewsonline.com",
  "odwyerpr.com",
  "bulldogreporter.com",
]);

function extractDomain(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function isLikelyAgencyDomain(domain: string): boolean {
  if (!domain) return false;
  if (BLOCKED_DOMAINS.has(domain)) return false;
  // Strip TLD and look for PR / comm / agency keywords. Permissive: most agency sites self-identify.
  // Don't filter too aggressively. The detected-tool stage filters again.
  return /\.(com|co|io|agency|us)$/.test(domain);
}

function guessAgencyName(result: ExaResult): string {
  // Try to extract from title. Most agency homepages title with "Agency Name | Tagline" or similar.
  if (result.title) {
    const cleaned = result.title
      // Split on common separators, keep the leading chunk.
      .split(/\s*[\|\-–—:•·]\s*/)[0]!
      // Strip trailing " l " (lowercase L sometimes used decoratively as a divider).
      .replace(/\s+l\s+.*$/i, "")
      .trim();
    if (cleaned.length > 1 && cleaned.length < 60) return cleaned;
  }
  // Fallback: derive from domain.
  const domain = extractDomain(result.url);
  const stem = domain.split(".")[0];
  return stem
    .split(/[-_]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

export async function sourceProspects(
  exa: ExaClient,
  contacted: ContactedFile,
  count: number,
): Promise<RawProspect[]> {
  // Pick 3 queries from the pool, rotated by week-of-year so different runs hit different angles.
  const weekOfYear = Math.floor((Date.now() / (1000 * 60 * 60 * 24 * 7)) % QUERY_POOL.length);
  const queries: string[] = [];
  for (let i = 0; i < 3; i++) {
    queries.push(QUERY_POOL[(weekOfYear + i) % QUERY_POOL.length]!);
  }

  const seen = new Set<string>();
  const candidates: RawProspect[] = [];

  for (const q of queries) {
    let resp;
    try {
      resp = await exa.search(q, {
        numResults: 12,
        type: "auto",
        useAutoprompt: true,
        text: { maxCharacters: 600 },
      });
    } catch (err) {
      console.error(`[source-prospects] Exa query failed for '${q}':`, err);
      continue;
    }
    for (const r of resp.results) {
      const domain = extractDomain(r.url);
      if (!isLikelyAgencyDomain(domain)) continue;
      if (seen.has(domain)) continue;
      seen.add(domain);

      const name = guessAgencyName(r);
      if (isAlreadyContacted(contacted, domain, name)) continue;

      candidates.push({
        name,
        domain,
        url: `https://${domain}/`,
        blurb: (r.text ?? "").slice(0, 500),
        source: `exa:${q.slice(0, 40)}`,
      });
    }
  }

  // Cap to count + buffer (some will fail downstream so over-source slightly).
  return candidates.slice(0, Math.max(count + 3, count));
}
