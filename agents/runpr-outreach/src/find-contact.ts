// Find a real decision-maker (founder / partner / SVP) at the agency. Pull names from leadership /
// about / team pages via Exa, then guess the email pattern.
//
// Confidence levels:
//   HIGH: name + title pulled from a leadership page on the agency's own domain.
//   MED:  name + title pulled from open-web (LinkedIn-adjacent, PRWeek, etc).
//   LOW:  no name. Falls back to info@domain or hello@domain.

import type { ExaClient } from "./exa-client.js";
import type { Contact, RawProspect } from "./types.js";

const SENIOR_TITLE_KEYWORDS = [
  "founder",
  "co-founder",
  "ceo",
  "president",
  "managing partner",
  "managing director",
  "general manager",
  "svp",
  "evp",
  "executive vice president",
  "senior vice president",
  "head of new business",
  "head of growth",
];

interface ExtractedPerson {
  first: string;
  last: string;
  title: string;
  source_url: string;
  on_own_domain: boolean;
}

function tidy(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Very permissive name+title extraction. Looks for patterns like "Jane Doe, CEO" or
// "Jane Doe — Founder" (dash variants) in scraped text.
function extractPeople(text: string, agencyDomain: string, sourceUrl: string): ExtractedPerson[] {
  if (!text) return [];
  const onOwnDomain = sourceUrl.toLowerCase().includes(agencyDomain.toLowerCase());
  const people: ExtractedPerson[] = [];

  // Pattern: "FirstName LastName, Title" or "FirstName LastName | Title"
  const lines = text.split(/[\n\r]+/);
  const namePattern = /\b([A-Z][a-z]{1,15})\s+([A-Z][a-z]{1,20})\b/g;
  const titleSeparator = /[,|\-–—:]/;

  for (const line of lines) {
    const trimmed = tidy(line);
    if (trimmed.length < 8 || trimmed.length > 180) continue;
    const lower = trimmed.toLowerCase();
    const matchedTitle = SENIOR_TITLE_KEYWORDS.find((kw) => lower.includes(kw));
    if (!matchedTitle) continue;

    // Find a name in the same line.
    let match: RegExpExecArray | null;
    namePattern.lastIndex = 0;
    while ((match = namePattern.exec(trimmed)) !== null) {
      const first = match[1]!;
      const last = match[2]!;
      const combo = `${first} ${last}`.toLowerCase();
      // Reject if either token is itself a job-title word ("Executive Vice", "Senior Vice",
      // "Chief Executive", etc.). Those leak through when titles are formatted weirdly.
      const titleTokens = new Set([
        "executive",
        "vice",
        "senior",
        "chief",
        "managing",
        "general",
        "head",
        "president",
        "director",
        "officer",
        "founder",
        "partner",
        "associate",
      ]);
      if (titleTokens.has(first.toLowerCase()) || titleTokens.has(last.toLowerCase())) continue;
      // Avoid common false positives (eg. "Press Releases", "United States").
      if (
        combo.startsWith("press ") ||
        combo.startsWith("united ") ||
        combo.startsWith("new ") ||
        combo.startsWith("client ") ||
        combo.startsWith("the ") ||
        combo.startsWith("our ") ||
        combo.startsWith("read ") ||
        combo.startsWith("learn ") ||
        first === last
      ) {
        continue;
      }
      // Find the segment after a separator that matches a title keyword.
      const separatorIdx = trimmed.search(titleSeparator);
      const titleGuess =
        separatorIdx > -1 ? tidy(trimmed.slice(separatorIdx + 1)).slice(0, 80) : matchedTitle;

      people.push({
        first,
        last,
        title: titleGuess || matchedTitle,
        source_url: sourceUrl,
        on_own_domain: onOwnDomain,
      });
      break; // One person per line max.
    }
  }
  return people;
}

function bestEmailPattern(
  first: string,
  last: string,
  domain: string,
): { email: string; pattern: Contact["email_pattern"] } {
  // Most common B2B agency pattern is first.last@. Use first@ as a fallback for boutique shops.
  const f = first.toLowerCase().replace(/[^a-z]/g, "");
  const l = last.toLowerCase().replace(/[^a-z]/g, "");
  if (!f || !l) {
    return { email: `info@${domain}`, pattern: "info" };
  }
  return { email: `${f}.${l}@${domain}`, pattern: "first.last" };
}

export async function findContact(exa: ExaClient, agency: RawProspect): Promise<Contact> {
  const candidates: ExtractedPerson[] = [];

  // 1. Look at the agency's own about/team/leadership pages.
  for (const path of ["about", "team", "leadership", "people", "our-team"]) {
    try {
      const resp = await exa.search(`${agency.name} ${path}`, {
        numResults: 3,
        includeDomains: [agency.domain],
        type: "keyword",
        text: { maxCharacters: 4000 },
      });
      for (const r of resp.results) {
        const text = r.text ?? "";
        candidates.push(...extractPeople(text, agency.domain, r.url));
      }
    } catch (err) {
      // Continue.
    }
    if (candidates.length > 0) break; // Got something on-domain; that's enough.
  }

  // 2. Open-web fallback.
  if (candidates.length === 0) {
    try {
      const resp = await exa.search(`${agency.name} founder OR CEO OR president`, {
        numResults: 5,
        text: { maxCharacters: 3000 },
      });
      for (const r of resp.results) {
        candidates.push(...extractPeople(r.text ?? "", agency.domain, r.url));
      }
    } catch (err) {
      // Continue.
    }
  }

  // Pick the best candidate. Prefer on-own-domain results.
  candidates.sort((a, b) => {
    if (a.on_own_domain && !b.on_own_domain) return -1;
    if (!a.on_own_domain && b.on_own_domain) return 1;
    return 0;
  });

  if (candidates.length === 0) {
    return {
      first_name: "team",
      last_name: "",
      title: "",
      email: `info@${agency.domain}`,
      email_pattern: "info",
      confidence: "LOW",
    };
  }

  const best = candidates[0]!;
  const { email, pattern } = bestEmailPattern(best.first, best.last, agency.domain);
  const confidence: Contact["confidence"] = best.on_own_domain ? "HIGH" : "MED";

  return {
    first_name: best.first,
    last_name: best.last,
    title: best.title,
    email,
    email_pattern: pattern,
    confidence,
  };
}
