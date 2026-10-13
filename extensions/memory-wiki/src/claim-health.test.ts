// Memory Wiki tests cover claim health plugin behavior.
import { describe, expect, it } from "vitest";
import {
  assessClaimFreshness,
  assessPageFreshness,
  buildPageContradictionClusters,
} from "./claim-health.js";
import type { WikiClaim, WikiPageSummary } from "./markdown.js";

function createPage(params: {
  relativePath: string;
  title: string;
  contradictions: string[];
}): WikiPageSummary {
  return {
    absolutePath: `/tmp/${params.relativePath}`,
    relativePath: params.relativePath,
    kind: "entity",
    title: params.title,
    hasFrontmatter: true,
    aliases: [],
    sourceIds: [],
    linkTargets: [],
    relationships: [],
    bestUsedFor: [],
    notEnoughFor: [],
    claims: [],
    contradictions: params.contradictions,
    questions: [],
    bridgeAgentIds: [],
  };
}

describe("buildPageContradictionClusters", () => {
  it("keeps combining-mark contradiction notes in separate clusters", () => {
    const clusters = buildPageContradictionClusters([
      createPage({
        relativePath: "entities/alpha.md",
        title: "Alpha",
        contradictions: ["किताब"],
      }),
      createPage({
        relativePath: "entities/beta.md",
        title: "Beta",
        contradictions: ["कीताब"],
      }),
    ]);

    expect(clusters).toHaveLength(2);
    expect(clusters.map((cluster) => cluster.key).toSorted()).toEqual(["किताब", "कीताब"]);
    expect(clusters.every((cluster) => cluster.entries)).toBe(true);
  });
});

describe("assessClaimFreshness", () => {
  it("keeps malformed claim timestamps unknown instead of using page freshness", () => {
    const page = createPage({
      relativePath: "entities/delta.md",
      title: "Delta",
      contradictions: [],
    });
    page.updatedAt = "2026-04-20T00:00:00.000Z";
    const claim: WikiClaim = {
      text: "Delta has malformed claim freshness metadata.",
      updatedAt: "not-a-date",
      evidence: [],
    };

    const freshness = assessClaimFreshness({
      page,
      claim,
      now: new Date("2026-04-25T00:00:00.000Z"),
    });

    expect(freshness.level).toBe("unknown");
    expect(freshness.lastTouchedAt).toBeUndefined();
    expect(freshness.reason).toBe("missing updatedAt");
  });
});

describe("wiki freshness boundaries", () => {
  it.each([{ age: 89, level: "aging", daysSinceTouch: 89 }])(
    "classifies a timestamp $age days old as $level",
    ({ age, level, daysSinceTouch }) => {
      const now = new Date("2026-06-01T00:00:00.000Z");
      const timestamp = new Date(now.getTime() - age * 24 * 60 * 60 * 1000).toISOString();
      const page = createPage({
        relativePath: "entities/alpha.md",
        title: "Alpha",
        contradictions: [],
      });
      page.updatedAt = timestamp;
      const claim: WikiClaim = {
        text: "Alpha has timestamped evidence.",
        updatedAt: timestamp,
        evidence: [],
      };
      const expected = {
        level,
        reason: `last touched ${timestamp}`,
        daysSinceTouch,
        lastTouchedAt: timestamp,
      };

      expect(assessPageFreshness(page, now)).toEqual(expected);
      expect(assessClaimFreshness({ page, claim, now })).toEqual(expected);
    },
  );
});
