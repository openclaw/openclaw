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

function scanWikiLinkTargets(raw: string): string[] {
  const result = scanWikiPageSummary({
    absolutePath: "/tmp/wiki/entities/test.md",
    relativePath: "entities/test.md",
    raw,
  });
  if (result.status !== "valid") {
    throw new Error(`Expected valid wiki page scan, got ${result.status}`);
  }
  return result.page.linkTargets;
}

it.each([
  ["hello world", "hello-world"],
  ["", "page"],
  ["किताब", "किताब"],
  ["कुतुब", "कुतुब"],
  ["कीताब", "कीताब"],
])("slugifies %j without collapsing distinct combining marks", (input, expected) => {
  expect(slugifyWikiSegment(input)).toBe(expected);
});

describe("human Notes blocks", () => {
  const startMarker = "<!-- openclaw:human:start -->";
  const endMarker = "<!-- openclaw:human:end -->";
  const rendered = ["# Source", "", "## Notes", startMarker, endMarker, ""].join("\n");

  it("ignores a standalone marker inside fenced source content", () => {
    const existing = `# Source\n\n## Content\n\`\`\`text\n${endMarker}\n\`\`\`\n`;

    expect(extractHumanNotesBlock(existing)).toBeNull();
    expect(preserveHumanNotesBlock(rendered, existing)).toBe(rendered);
  });

  it("preserves marker comments embedded in complete human Notes", () => {
    const notes = `Before copied markers\n${startMarker}\nBetween copied markers\n${endMarker}\nAfter copied markers`;
    const existing = rendered.replace(
      `${startMarker}\n${endMarker}`,
      `${startMarker}\n${notes}\n${endMarker}`,
    );

    expect(extractHumanNotesBlock(existing)).toBe(`${startMarker}\n${notes}\n${endMarker}`);
    expect(preserveHumanNotesBlock(rendered, existing)).toBe(existing);
  });

  it.each([startMarker, endMarker])("rejects an unpaired producer-page marker %s", (marker) => {
    const existing = `# Concept\n\n## Notes\n${marker}\nHandwritten note.\n`;

    expect(() => preserveHumanNotesBlock(rendered, existing, { producerMarkdown: true })).toThrow(
      "human Notes are missing",
    );
  });

  it.each(["\n", "\r\n"])("preserves legacy Notes under an open producer fence (%j)", (newline) => {
    const humanBlock = [startMarker, "Keep café and trailing spaces.  ", endMarker].join(newline);
    const existing = `~~~sql${newline}SELECT 1${newline}## Notes${newline}${humanBlock}${newline}`;

    expect(preserveHumanNotesBlock(rendered, existing, { producerMarkdown: true })).toBe(
      rendered.replace(`${startMarker}\n${endMarker}`, () => humanBlock),
    );
  });

  it("does not preserve a legacy producer's closed Notes example", () => {
    const existing = `~~~markdown\n## Notes\n${startMarker}\nProducer example.\n${endMarker}\n~~~`;

    expect(preserveHumanNotesBlock(rendered, existing, { producerMarkdown: true })).toBe(rendered);
  });
});

describe("toWikiPageSummary", () => {
  it("normalizes agent-facing people wiki metadata", () => {
    const relationships = [
      {
        targetId: "entity.alice",
        targetTitle: "Alice",
        kind: "collaborates-with",
        weight: 0.7,
        confidence: 0.6,
        evidenceKind: "discrawl-stat",
        privacyTier: "local-private",
      },
    ];
    const evidence = [
      {
        kind: "maintainer-whois",
        sourceId: "source.maintainers",
        confidence: 0.8,
        privacyTier: "local-private",
      },
    ];
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
          email: "brad@example.com",
          lane: "Microsoft Teams",
          confidence: 0.8,
          privacyTier: "confirm-before-use",
        },
        relationships,
        claims: [
          {
            id: "claim.brad.teams",
            text: "Brad is useful for Microsoft Teams routing.",
            confidence: 0.9,
            evidence,
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
    expect(summary).toMatchObject({
      entityType: "person",
      canonicalId: "maintainer.brad-groux",
      aliases: ["brad", "bgroux"],
      privacyTier: "local-private",
      bestUsedFor: ["Microsoft ecosystem routing"],
      notEnoughFor: ["legal approval"],
      lastRefreshedAt: "2026-04-29T00:00:00.000Z",
      personCard: expect.objectContaining({
        handles: ["@bgroux"],
        emails: ["brad@example.com"],
        lane: "Microsoft Teams",
        privacyTier: "confirm-before-use",
      }),
    });
    expect(summary?.relationships).toEqual(relationships);
    expect(summary?.claims[0]?.id).toBe("claim.brad.teams");
    expect(summary?.claims[0]?.evidence).toEqual(evidence);
  });

  it("reports and excludes sequence frontmatter roots from page scans", () => {
    const raw = "---\n- pageType: synthesis\n---\n\n# Invalid Root";
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
  });
});

it.each([
  [
    "longer closing fence",
    "# Longer Close\n\n```scala\ndef handle(req: Request[A]): Future[Option[User]] = ???\n````\n\nProse: [[RealTarget]]",
    "RealTarget",
  ],
  [
    "shorter inner fence",
    "# Long Fence With Shorter Inner Line\n\n``````bash\nsome code\n```\n[[not-a-link]]\n``````\n\nAfter fence: [[RealPage]]",
    "RealPage",
  ],
])("excludes fenced link targets with a %s (#97945)", (_name, markdown, target) => {
  expect(scanWikiLinkTargets(markdown)).toEqual([target]);
});
