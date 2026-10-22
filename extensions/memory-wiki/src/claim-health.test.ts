import { describe, expect, it } from "vitest";
import {
  assessClaimFreshness,
  assessPageFreshness,
  buildPageContradictionClusters,
} from "./claim-health.js";
import type { WikiClaim, WikiPageSummary } from "./markdown.js";

function createPage(title: string, contradictions: string[] = []): WikiPageSummary {
  const relativePath = `entities/${title.toLowerCase()}.md`;
  return {
    absolutePath: `/tmp/${relativePath}`,
    relativePath,
    kind: "entity",
    title,
    hasFrontmatter: true,
    aliases: [],
    sourceIds: [],
    linkTargets: [],
    relationships: [],
    bestUsedFor: [],
    notEnoughFor: [],
    claims: [],
    contradictions,
    questions: [],
    bridgeAgentIds: [],
  };
}

describe("wiki claim health", () => {
  it("keeps combining-mark contradiction notes in separate clusters", () => {
    const clusters = buildPageContradictionClusters([
      createPage("Alpha", ["किताब"]),
      createPage("Beta", ["कीताब"]),
    ]);

    expect(clusters).toHaveLength(2);
    expect(clusters.map((cluster) => cluster.key).toSorted()).toEqual(["किताब", "कीताब"]);
    expect(clusters.every((cluster) => cluster.entries)).toBe(true);
  });
  it("keeps malformed claim timestamps unknown instead of using page freshness", () => {
    const page = createPage("Delta");
    page.updatedAt = "2026-04-20T00:00:00.000Z";
    const claim: WikiClaim = { text: "Claim", updatedAt: "not-a-date", evidence: [] };

    const freshness = assessClaimFreshness({
      page,
      claim,
      now: new Date("2026-04-25T00:00:00.000Z"),
    });

    expect(freshness).toMatchObject({ level: "unknown", reason: "missing updatedAt" });
    expect(freshness.lastTouchedAt).toBeUndefined();
  });
  it("classifies a timestamp 89 days old as aging", () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const timestamp = new Date(now.getTime() - 89 * 24 * 60 * 60 * 1000).toISOString();
    const page = createPage("Alpha");
    page.updatedAt = timestamp;
    const claim: WikiClaim = { text: "Claim", updatedAt: timestamp, evidence: [] };
    const expected = {
      level: "aging",
      reason: `last touched ${timestamp}`,
      daysSinceTouch: 89,
      lastTouchedAt: timestamp,
    };

    expect(assessPageFreshness(page, now)).toEqual(expected);
    expect(assessClaimFreshness({ page, claim, now })).toEqual(expected);
  });
});
