import { describe, expect, it } from "vitest";
import {
  extractHumanNotesBlock,
  parseWikiMarkdown,
  preserveHumanNotesBlock,
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

it("keeps inline link filtering while parsing CommonMark destinations", () => {
  const markdown = [
    "[[Wiki target|Alias]]",
    '[Plan](../syntheses/plan(v2).md?view=full#details "Project plan")',
    "[Escaped](../syntheses/plan\\(v3\\).md)",
    "![Image](../assets/diagram.png)",
    "[External](https://example.com/page.md)",
    "[Anchor](#details)",
    "`[Inline code](inline.md)`",
    "```markdown\n[Fenced code](fenced.md)\n```",
    "<!-- openclaw:wiki:related:start -->",
    "[Generated](generated.md)",
    "<!-- openclaw:wiki:related:end -->",
    "[Reference][ref]\n\n[ref]: reference.md",
  ].join("\n\n");

  expect(scanWikiLinkTargets(markdown)).toEqual([
    "Wiki target",
    "syntheses/plan(v2).md",
    "syntheses/plan(v3).md",
    "assets/diagram.png",
  ]);
});

it("decodes percent-encoded inline link destinations", () => {
  const markdown = [
    "[Notes](../syntheses/plan%20notes.md)",
    "[Cafe](../syntheses/caf%C3%A9.md#menu)",
    "[Malformed](../syntheses/100%.md)",
  ].join("\n\n");

  expect(scanWikiLinkTargets(markdown)).toEqual([
    "syntheses/plan notes.md",
    "syntheses/café.md",
    "syntheses/100%.md",
  ]);
});
