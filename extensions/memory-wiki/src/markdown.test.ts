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

function scanWikiSummary(raw: string) {
  const result = scanWikiPageSummary({
    absolutePath: "/tmp/wiki/entities/test.md",
    relativePath: "entities/test.md",
    raw,
  });
  if (result.status !== "valid") {
    throw new Error(`Expected valid wiki page scan, got ${result.status}`);
  }
  return result.page;
}

it.each([
  ["hello world", "hello-world"],
  ["", "page"],
  ["किताब", "किताब"],
  ["कुतुब", "कुतुब"],
  ["कीताब", "कीताब"],
  [" _Alpha--\u00a0\t!_Beta-- ", "alpha-beta"],
  [" --\u2028__ ", "page"],
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

describe("renderWikiMarkdown", () => {
  const original = [
    "---",
    "# provenance: imported from the OKF export",
    "title: Alpha",
    "build: 007",
    "big: 12345678901234567890",
    "confidence: 0.3",
    "tags:",
    "  - alpha # team tag",
    "---",
    "",
    "# Alpha",
    "",
  ].join("\n");

  it("keeps a keep-chomped block scalar's trailing newlines when a sibling key is removed", () => {
    const page = [
      "---",
      "notes: |+",
      "  body",
      "",
      "",
      "extra: drop me",
      "---",
      "",
      "# Alpha",
      "",
    ].join("\n");
    const { frontmatter } = parseWikiMarkdown(page);
    const { extra: _extra, ...kept } = frontmatter;

    const rendered = renderWikiMarkdown({ frontmatter: kept, body: "# Alpha\n", original: page });

    // The removed sibling's line break stays so the kept blank lines read back as the value.
    expect(rendered).toContain("notes: |+\n  body\n");
    expect(rendered).not.toContain("extra");
    expect(parseWikiMarkdown(rendered).frontmatter).toEqual(kept);
  });

  it("drops keys the caller removed and re-renders pages without readable source", () => {
    const { frontmatter } = parseWikiMarkdown(original);
    const { confidence: _confidence, ...kept } = frontmatter;
    const patched = renderWikiMarkdown({ frontmatter: kept, body: "# Alpha\n", original });
    expect(patched).not.toContain("confidence");
    // The sibling comments and numeric tokens the caller left alone are the page's own spelling.
    expect(patched).toContain("# provenance: imported from the OKF export\n");
    expect(patched).toContain("build: 007\n");
    expect(patched).toContain("big: 12345678901234567890\n");
    expect(patched).toContain("- alpha # team tag\n");
    expect(renderWikiMarkdown({ frontmatter: { title: "Alpha" }, body: "# Alpha\n" })).toBe(
      "---\ntitle: Alpha\n---\n\n# Alpha\n",
    );
    // Non-string keys cannot be addressed by `Document.set`/`delete`, so such a page re-renders
    // from values instead of gaining a second pair for the same key.
    expect(
      renderWikiMarkdown({
        frontmatter: { "1": "beta", title: "T" },
        body: "# Alpha\n",
        original: "---\n1: alpha\ntitle: T\n---\n\n# Alpha\n",
      }),
    ).toBe('---\n"1": beta\ntitle: T\n---\n\n# Alpha\n');
  });

  it.each([
    {
      shape: "value anchor",
      source: "---\nbuild: 007\nstatus: &s active\ncustomStatus: *s\n---\n\n# Alpha\n",
      frontmatter: { build: 7, customStatus: "active", status: "review" },
      rendered: "---\nbuild: 7\ncustomStatus: active\nstatus: review\n---\n\n# Alpha\n",
    },
    {
      shape: "anchored key spelled twice",
      source: "---\nbuild: 007\n? &k status\n: active\n? *k\n: draft\nmirror: *k\n---\n\n# Alpha\n",
      frontmatter: { build: 7, mirror: "status", status: "review" },
      rendered: "---\nbuild: 7\nmirror: status\nstatus: review\n---\n\n# Alpha\n",
    },
    {
      shape: "self-containing list",
      source: "---\nbuild: 007\nquestions: &q\n  - *q\nmirror: *q\ntitle: Alpha\n---\n\n# Alpha\n",
      frontmatter: { build: 7, questions: ["x"], mirror: ["x"], title: "Alpha" },
      rendered: "---\nbuild: 7\nquestions:\n  - x\nmirror:\n  - x\ntitle: Alpha\n---\n\n# Alpha\n",
    },
    {
      shape: "explicit !!bool tag",
      source: "---\nbuild: 007\nstatus: !!bool true\n---\n\n# Alpha\n",
      frontmatter: { build: 7, status: "review" },
      rendered: "---\nbuild: 7\nstatus: review\n---\n\n# Alpha\n",
    },
  ])(
    "re-renders a declined page ($shape) from values so the requested write survives",
    ({ source, frontmatter, rendered }) => {
      const page = renderWikiMarkdown({ frontmatter, body: "# Alpha\n", original: source });
      expect(page).toBe(rendered);
      expect(parseWikiMarkdown(page).frontmatter).toEqual(frontmatter);
    },
  );

  it("renders an explicitly tagged page from values instead of throwing", () => {
    // apply.ts writes `updatedAt` as an ISO string, and yaml hands that string to the source
    // node's `!!timestamp` schema, which reads it as a Date and dies.
    const source = "---\nupdatedAt: !!timestamp 2026-01-01\nbuild: 007\n---\n\n# Alpha\n";

    expect(
      renderWikiMarkdown({
        frontmatter: { build: 7, updatedAt: "2026-11-04T05:00:00.000Z" },
        body: "# Alpha\n",
        original: source,
      }),
    ).toBe("---\nbuild: 7\nupdatedAt: 2026-11-04T05:00:00.000Z\n---\n\n# Alpha\n");
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
    "```scala\n# install first\ndef handle(req: Request[A]): Future[Option[User]] = ???\n````\n\n# Longer Close\n\nProse: [[RealTarget]]",
    { title: "Longer Close", linkTargets: ["RealTarget"] },
  ],
  [
    "shorter inner fence",
    "# Long `Fence` With Shorter Inner Line\n\n``````bash\nsome code\n```\n[[not-a-link]]\n``````\n\nAfter fence: [[RealPage]]",
    { title: "Long `Fence` With Shorter Inner Line", linkTargets: ["RealPage"] },
  ],
])("ignores fenced links and title comments (%s, #97945)", (_name, markdown, expected) => {
  expect(scanWikiSummary(markdown)).toMatchObject(expected);
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
    "[Notes](../syntheses/plan%20notes.md)",
    "[Cafe](../syntheses/caf%C3%A9.md#menu)",
    "[Malformed](../syntheses/100%.md)",
  ].join("\n\n");

  expect(scanWikiSummary(markdown).linkTargets).toEqual([
    "Wiki target",
    "syntheses/plan(v2).md",
    "syntheses/plan(v3).md",
    "assets/diagram.png",
    "syntheses/plan notes.md",
    "syntheses/café.md",
    "syntheses/100%.md",
  ]);
});
