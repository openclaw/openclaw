import assert from "node:assert/strict";
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
  const start = "<!-- openclaw:human:start -->";
  const end = "<!-- openclaw:human:end -->";
  const empty = `${start}\n${end}`;
  const rendered = `# Source\n\n## Notes\n${empty}\n`;
  const notes = `Before copied markers\n${start}\nBetween copied markers\n${end}\nAfter copied markers`;
  const block = `${start}\n${notes}\n${end}`;
  it.each([
    [`# Source\n\n## Content\n\`\`\`text\n${end}\n\`\`\`\n`, null, false],
    [rendered.replace(empty, () => block), block, false],
    [`~~~markdown\n## Notes\n${start}\nProducer example.\n${end}\n~~~`, null, true],
    ...["\n", "\r\n"].map((newline) => {
      const human = [start, "Keep café and trailing spaces.  ", end].join(newline);
      return [
        `~~~sql${newline}SELECT 1${newline}## Notes${newline}${human}${newline}`,
        human,
        true,
      ] as const;
    }),
  ] as const)("preserves only actual complete Notes in %j", (existing, kept, producerMarkdown) => {
    expect(extractHumanNotesBlock(existing, { producerMarkdown })).toBe(kept);
    expect(preserveHumanNotesBlock(rendered, existing, { producerMarkdown })).toBe(
      kept === null ? rendered : rendered.replace(empty, () => kept),
    );
  });
  it.each([start, end])("rejects an unpaired producer marker %s", (marker) => {
    const existing = `# Concept\n\n## Notes\n${marker}\nHandwritten note.\n`;
    const preserve = () => preserveHumanNotesBlock(rendered, existing, { producerMarkdown: true });
    expect(preserve).toThrow("human Notes are missing");
  });
});

describe("renderWikiMarkdown", () => {
  const body = "# Alpha\n";
  const frontmatter = {
    build: 7,
    status: "review",
    customStatus: "active",
    mirror: "status",
    questions: ["x"],
    updatedAt: "2026-11-04T05:00:00.000Z",
  };
  const canonical = renderWikiMarkdown({ frontmatter, body });
  it.each([
    "1: alpha\ntitle: T",
    "? { a: b }\n: value\nstatus: active",
    "build: 007\nstatus: &s active\ncustomStatus: *s",
    "build: 007\n? &k status\n: active\n? *k\n: draft\nmirror: *k",
    "build: 007\nquestions: &q\n  - *q\nmirror: *q\ntitle: Alpha",
    "build: 007\nstatus: !!bool true",
    "updatedAt: !!timestamp 2026-01-01\nbuild: 007",
  ])("retains published value rendering for unsupported source %j", (source) => {
    const original = `---\n${source}\n---\n\n${body}`;
    const page = renderWikiMarkdown({ frontmatter, body, original });
    expect(page).toBe(canonical);
    expect(parseWikiMarkdown(page).frontmatter).toEqual(frontmatter);
  });
  it("keeps block-scalar newlines when deleting a sibling", () => {
    const original = "---\nnotes: |+\n  body\n\n\nextra: drop me\n---\n\n# Alpha\n";
    const { extra: _extra, ...kept } = parseWikiMarkdown(original).frontmatter;
    const page = renderWikiMarkdown({ frontmatter: kept, body, original });
    expect(page).toContain("notes: |+\n  body\n");
    expect(page).not.toContain("extra");
    expect(parseWikiMarkdown(page).frontmatter).toEqual(kept);
  });
});

describe("toWikiPageSummary", () => {
  it("reports and excludes sequence frontmatter roots from page scans", () => {
    const raw = "---\n- pageType: synthesis\n---\n\n# Invalid Root";
    const relativePath = "syntheses/invalid-root.md";
    const params = { absolutePath: `/tmp/wiki/${relativePath}`, relativePath, raw };
    const result = scanWikiPageSummary(params);
    assert(result.status === "invalid-frontmatter", "expected invalid frontmatter result");

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

it("filters literal links while parsing CommonMark destinations", () => {
  const markdown = [
    '\\\\[[Wiki target|Alias]]\n\n[Plan](../syntheses/plan(v2).md?view=full#details "Project plan")\n\n[Escaped](../syntheses/plan\\(v3\\).md)\n\n![Image](../assets/diagram.png)',
    "[External](https://example.com/page.md)\n\n[Anchor](#details)\n\n`[Inline code](inline.md)`\n\n```markdown\n[Fenced code](fenced.md)\n```\n\n<!-- [[missing-comment]] [[Literal]] -->\n<!--\n[[missing-multiline]]\n-->\n\\[[missing-escape]] and \\[[Literal]]\n\\\\\\[[missing-odd-run]]",
    "<!-- openclaw:wiki:related:start -->\n\n[Generated](generated.md)\n\n<!-- openclaw:wiki:related:end -->",
    "[Reference][ref]\n\n[ref]: reference.md\n\n[Notes](../syntheses/plan%20notes.md)\n\n[Cafe](../syntheses/caf%C3%A9.md#menu)\n\n[Malformed](../syntheses/100%.md)",
  ].join("\n\n");

  expect(scanWikiSummary(markdown).linkTargets).toEqual(
    "Wiki target\nsyntheses/plan(v2).md\nsyntheses/plan(v3).md\nassets/diagram.png\nsyntheses/plan notes.md\nsyntheses/café.md\nsyntheses/100%.md".split(
      "\n",
    ),
  );
});
