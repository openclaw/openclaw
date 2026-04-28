// Fingerprint which PR tool stack an agency is using. Strategy:
//   1. Vendor case-study scrape: Exa search restricted to muckrack.com, cision.com, meltwater.com
//      for the agency's name. Hits there are strong evidence (HIGH).
//   2. Press-release wire footers: search the agency's domain for "via Cision" / "via PR Newswire"
//      / "via Business Wire" patterns. PR Newswire = Cision-owned. Business Wire = independent.
//   3. On-site widget / job listing fingerprints: search the agency's domain for Cision/Muck Rack/
//      Meltwater string mentions (often surface in careers pages, blog posts, "tools we use").
//   4. Generic Exa search across the open web combining agency name with each tool.
//
// We rate confidence based on how many independent signals corroborate.

import type { ExaClient } from "./exa-client.js";
import type { DetectedTool, DetectedToolResult, RawProspect } from "./types.js";

interface ToolHit {
  tool: DetectedTool;
  source: "vendor-case-study" | "wire-footer" | "site-fingerprint" | "open-web";
  evidence: string;
}

async function searchForHits(
  exa: ExaClient,
  agency: RawProspect,
): Promise<ToolHit[]> {
  const hits: ToolHit[] = [];
  const name = agency.name;
  const domain = agency.domain;

  // 1. Vendor case-study hunt. Each vendor has a /case-studies or /customers area.
  const vendorChecks: Array<{ tool: DetectedTool; domain: string }> = [
    { tool: "muckrack", domain: "muckrack.com" },
    { tool: "cision", domain: "cision.com" },
    { tool: "meltwater", domain: "meltwater.com" },
  ];
  for (const v of vendorChecks) {
    try {
      const resp = await exa.search(`"${name}" PR agency`, {
        numResults: 3,
        includeDomains: [v.domain],
        type: "keyword",
        useAutoprompt: false,
      });
      for (const r of resp.results) {
        if (r.url.includes(v.domain)) {
          hits.push({
            tool: v.tool,
            source: "vendor-case-study",
            evidence: `${v.domain}: ${r.title?.slice(0, 100) ?? r.url}`,
          });
        }
      }
    } catch (err) {
      // Non-fatal; continue.
      console.error(`[detect-tools] vendor scan ${v.domain} failed:`, (err as Error).message);
    }
  }

  // 2. Site fingerprint: search the agency's domain itself for tool mentions.
  const fingerprintQueries: Array<{ tool: DetectedTool; query: string }> = [
    { tool: "muckrack", query: "Muck Rack" },
    { tool: "cision", query: "Cision" },
    { tool: "meltwater", query: "Meltwater" },
  ];
  for (const f of fingerprintQueries) {
    try {
      const resp = await exa.search(`"${f.query}"`, {
        numResults: 3,
        includeDomains: [domain],
        type: "keyword",
        useAutoprompt: false,
      });
      for (const r of resp.results) {
        if (r.url.toLowerCase().includes(domain)) {
          hits.push({
            tool: f.tool,
            source: "site-fingerprint",
            evidence: `${domain}: ${r.title?.slice(0, 100) ?? r.url}`,
          });
        }
      }
    } catch (err) {
      console.error(`[detect-tools] fingerprint ${f.tool} failed:`, (err as Error).message);
    }
  }

  // 3. Wire footer: scan the agency domain for press release distribution mentions.
  try {
    const resp = await exa.search(`"PR Newswire" OR "via Cision"`, {
      numResults: 3,
      includeDomains: [domain],
      type: "keyword",
      useAutoprompt: false,
    });
    for (const r of resp.results) {
      hits.push({
        tool: "cision",
        source: "wire-footer",
        evidence: `wire footer on ${domain}: ${r.title?.slice(0, 80) ?? r.url}`,
      });
    }
  } catch (err) {
    // Non-fatal.
  }

  return hits;
}

export async function detectTools(
  exa: ExaClient,
  agency: RawProspect,
): Promise<DetectedToolResult> {
  const hits = await searchForHits(exa, agency);

  // Tally hits per tool, weighted by source strength.
  const weights: Record<ToolHit["source"], number> = {
    "vendor-case-study": 3,
    "wire-footer": 2,
    "site-fingerprint": 2,
    "open-web": 1,
  };
  const scores: Record<DetectedTool, number> = {
    muckrack: 0,
    cision: 0,
    meltwater: 0,
    multi: 0,
    unknown: 0,
  };
  for (const h of hits) {
    scores[h.tool] += weights[h.source];
  }

  const detectedTools = (["muckrack", "cision", "meltwater"] as const).filter(
    (t) => scores[t] > 0,
  );

  let tool: DetectedTool = "unknown";
  let confidence: "HIGH" | "MED" | "LOW" = "LOW";

  if (detectedTools.length === 0) {
    tool = "unknown";
    confidence = "LOW";
  } else if (detectedTools.length >= 2) {
    tool = "multi";
    confidence = "MED";
  } else {
    tool = detectedTools[0]!;
    const score = scores[tool];
    if (score >= 3) confidence = "HIGH";
    else if (score >= 2) confidence = "MED";
    else confidence = "LOW";
  }

  return {
    tool,
    confidence,
    evidence: hits.map((h) => `[${h.source}] ${h.evidence}`),
  };
}
