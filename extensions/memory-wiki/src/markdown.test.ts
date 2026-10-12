// Memory Wiki tests cover markdown plugin behavior.

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractHumanNotesBlock,
  parseWikiMarkdown,
  preserveHumanNotesBlock,
  renderWikiMarkdown,
  scanWikiPageSummary,
  slugifyWikiSegment,
  toWikiPageSummary,
} from "./markdown.js";

function scanWikiLinkTargets(markdown: string, relativePath: string): string[] {
  const result = scanWikiPageSummary({
    absolutePath: path.join("/tmp/wiki", relativePath),
    relativePath,
    raw: markdown,
  });
  if (result.status !== "valid") {
    throw new Error(`Expected valid wiki page scan, got ${result.status}`);
  }
  return result.page.linkTargets;
}

describe("slugifyWikiSegment", () => {
  it("keeps ASCII behavior unchanged", () => {
    expect(slugifyWikiSegment("hello world")).toBe("hello-world");
    expect(slugifyWikiSegment("")).toBe("page");
  });

  it("retains combining marks so distinct titles do not collapse", () => {
    expect(slugifyWikiSegment("किताब")).toBe("किताब");
    expect(slugifyWikiSegment("कुतुब")).toBe("कुतुब");
    expect(slugifyWikiSegment("कीताब")).toBe("कीताब");
  });
});

describe("human Notes blocks", () => {
  const startMarker = "<!-- openclaw:human:start -->";
  const endMarker = "<!-- openclaw:human:end -->";
  const rendered = ["# Source", "", "## Notes", startMarker, endMarker, ""].join("\n");

  it.each([endMarker])("ignores a standalone marker inside fenced source content", (marker) => {
    const existing = ["# Source", "", "## Content", "```text", marker, "```", ""].join("\n");

    expect(extractHumanNotesBlock(existing)).toBeNull();
    expect(preserveHumanNotesBlock(rendered, existing)).toBe(rendered);
  });

  it("preserves marker comments embedded in complete human Notes", () => {
    const notes = [
      "Before copied markers",
      startMarker,
      "Between copied markers",
      endMarker,
      "After copied markers",
    ].join("\n");
    const existing = rendered.replace(
      `${startMarker}\n${endMarker}`,
      `${startMarker}\n${notes}\n${endMarker}`,
    );

    expect(extractHumanNotesBlock(existing)).toBe(`${startMarker}\n${notes}\n${endMarker}`);
    expect(preserveHumanNotesBlock(rendered, existing)).toBe(existing);
  });
});

describe("toWikiPageSummary", () => {
  it("normalizes agent-facing people wiki metadata", () => {
    const raw = renderWikiMarkdown({
      frontmatter: {
        pageType: "entity",
        entityType: "person",
        id: "entity.brad",
        title: "Brad Groux",
        canonicalId: "maintainer.brad-groux",
        aliases: ["brad", "bgroux"],
        privacyTier: "local-private",
        bestUsedFor: ["Microsoft ecosystem routing"],
        notEnoughFor: ["legal approval"],
        lastRefreshedAt: "2026-04-29T00:00:00.000Z",
        personCard: {
          handles: ["@bgroux"],
          socials: ["https://x.example/bgroux"],
          email: "brad@example.com",
          timezone: "America/Chicago",
          lane: "Microsoft Teams",
          askFor: ["Teams and Azure questions"],
          avoidAskingFor: ["unrelated billing"],
          confidence: 0.8,
          privacyTier: "confirm-before-use",
          lastRefreshedAt: "2026-04-28T00:00:00.000Z",
        },
        relationships: [
          {
            targetId: "entity.alice",
            targetTitle: "Alice",
            kind: "collaborates-with",
            weight: 0.7,
            confidence: 0.6,
            evidenceKind: "discrawl-stat",
            privacyTier: "local-private",
          },
        ],
        claims: [
          {
            id: "claim.brad.teams",
            text: "Brad is useful for Microsoft Teams routing.",
            confidence: 0.9,
            evidence: [
              {
                kind: "maintainer-whois",
                sourceId: "source.maintainers",
                confidence: 0.8,
                privacyTier: "local-private",
              },
            ],
          },
        ],
      },
      body: "# Brad Groux\n",
    });

    const summary = toWikiPageSummary({
      absolutePath: "/tmp/wiki/entities/brad.md",
      relativePath: "entities/brad.md",
      raw,
    });
    if (!summary) {
      throw new Error("expected wiki summary");
    }

    expect(summary.entityType).toBe("person");
    expect(summary.canonicalId).toBe("maintainer.brad-groux");
    expect(summary.aliases).toEqual(["brad", "bgroux"]);
    expect(summary.privacyTier).toBe("local-private");
    expect(summary.bestUsedFor).toEqual(["Microsoft ecosystem routing"]);
    expect(summary.notEnoughFor).toEqual(["legal approval"]);
    expect(summary.lastRefreshedAt).toBe("2026-04-29T00:00:00.000Z");
    expect(summary.personCard?.handles).toEqual(["@bgroux"]);
    expect(summary.personCard?.emails).toEqual(["brad@example.com"]);
    expect(summary.personCard?.lane).toBe("Microsoft Teams");
    expect(summary.personCard?.privacyTier).toBe("confirm-before-use");
    expect(summary.relationships).toEqual([
      {
        targetId: "entity.alice",
        targetTitle: "Alice",
        kind: "collaborates-with",
        weight: 0.7,
        confidence: 0.6,
        evidenceKind: "discrawl-stat",
        privacyTier: "local-private",
      },
    ]);
    expect(summary.claims[0]?.id).toBe("claim.brad.teams");
    expect(summary.claims[0]?.evidence).toEqual([
      {
        kind: "maintainer-whois",
        sourceId: "source.maintainers",
        confidence: 0.8,
        privacyTier: "local-private",
      },
    ]);
  });

  it.each([{ name: "sequence", frontmatter: "- pageType: synthesis" }])(
    "reports and excludes $name frontmatter roots from page scans",
    ({ frontmatter }) => {
      const raw = ["---", frontmatter, "---", "", "# Invalid Root"].join("\n");
      const params = {
        absolutePath: "/tmp/wiki/syntheses/invalid-root.md",
        relativePath: "syntheses/invalid-root.md",
        raw,
      };
      const result = scanWikiPageSummary(params);
      if (result.status !== "invalid-frontmatter") {
        throw new Error("expected invalid frontmatter result");
      }

      expect(result.error.message).toBe("Wiki frontmatter must be a YAML mapping");
      expect(toWikiPageSummary(params)).toBeNull();
      expect(() => parseWikiMarkdown(raw)).toThrow("Wiki frontmatter must be a YAML mapping");
    },
  );
});

describe("scanWikiPageSummary linkTargets", () => {
  it("accepts a closing fence longer than the opening fence (#97945)", () => {
    // CommonMark allows the closing fence to be the same or longer than the
    // opening fence.  A `` ``` `` opener with a `` ```` `` closer must still
    // strip the block so the Scala generic inside is not extracted.
    const markdown = [
      "# Longer Close",
      "",
      "```scala",
      "def handle(req: Request[A]): Future[Option[User]] = ???",
      "````",
      "",
      "Prose: [[RealTarget]]",
    ].join("\n");
    const links = scanWikiLinkTargets(markdown, "entities/test.md");
    expect(links).toEqual(["RealTarget"]);
  });

  it("does not leak [[…]] when a shorter fence-like line appears inside a longer fenced block (#97945)", () => {
    // A 6-backtick block containing a shorter 3-backtick line before the real
    // 6-backtick close must not cause the scanner to exit early.
    const markdown = [
      "# Long Fence With Shorter Inner Line",
      "",
      "``````bash",
      "some code",
      "```",
      "[[not-a-link]]",
      "``````",
      "",
      "After fence: [[RealPage]]",
    ].join("\n");
    const links = scanWikiLinkTargets(markdown, "entities/test.md");
    expect(links).toEqual(["RealPage"]);
  });
});
