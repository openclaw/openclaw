import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyMemoryWikiMutation, normalizeMemoryWikiMutationInput } from "./apply.js";
import { parseWikiMarkdown, renderWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

async function writeEntity(
  rootDir: string,
  name: string,
  metadata: Record<string, unknown> = {},
  body = `# ${name}\n`,
) {
  const targetPath = path.join(rootDir, "entities", `${name.toLowerCase()}.md`);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(
    targetPath,
    renderWikiMarkdown({
      frontmatter: {
        pageType: "entity",
        id: `entity.${name.toLowerCase()}`,
        title: name,
        ...metadata,
      },
      body,
    }),
    "utf8",
  );
  return targetPath;
}
const synthesisInput = {
  title: "Alpha Synthesis",
  body: "Alpha summary body.",
  sourceIds: ["source.alpha"],
};

describe("applyMemoryWikiMutation", () => {
  it.each([
    ["create_synthesis", { ...synthesisInput, confidence: "0.7" }, { confidence: 0.7 }],
    ["update_metadata", { lookup: "entity.alpha", confidence: "0.4" }, { confidence: 0.4 }],
    ["synthesis", synthesisInput, { op: "create_synthesis", title: "Alpha Synthesis" }],
    [
      "metadata",
      { lookup: "entity.alpha", sourceIds: ["source.alpha"] },
      { op: "update_metadata", lookup: "entity.alpha" },
    ],
  ] as const)("normalizes confidence and aliases for %s", (op, input, expected) => {
    expect(normalizeMemoryWikiMutationInput({ op, ...input })).toMatchObject(expected);
  });

  it("creates synthesis pages with managed summary blocks and refreshed indexes", async () => {
    const { rootDir, config } = await createVault();

    const metadata = {
      sourceIds: ["source.alpha", "source.beta"],
      claims: [
        {
          id: "claim.alpha.postgres",
          text: "Alpha uses PostgreSQL for production writes.",
          status: "supported",
          confidence: 0.86,
          evidence: [{ sourceId: "source.alpha", lines: "12-18", weight: 0.9 }],
        },
      ],
      contradictions: ["Needs a better primary source"],
      questions: ["What changed after launch?"],
      confidence: 0.7,
    };
    const result = await applyMemoryWikiMutation({
      config,
      mutation: {
        op: "create_synthesis",
        title: "Alpha Synthesis",
        body: "Alpha summary body.",
        ...structuredClone(metadata),
      },
    });

    expect(result).toMatchObject({
      changed: true,
      pagePath: "syntheses/alpha-synthesis.md",
      pageId: "synthesis.alpha-synthesis",
      compile: { pageCounts: { synthesis: 1 } },
    });

    const page = await fs.readFile(path.join(rootDir, result.pagePath), "utf8");
    const parsed = parseWikiMarkdown(page);

    expect(parsed.frontmatter).toMatchObject({
      pageType: "synthesis",
      id: "synthesis.alpha-synthesis",
      title: "Alpha Synthesis",
      ...metadata,
      claims: metadata.claims.map((claim) => expect.objectContaining(claim)),
      status: "active",
    });
    expect(parsed.body).toContain("## Summary");
    expect(parsed.body).toContain("<!-- openclaw:wiki:generated:start -->");
    expect(parsed.body).toContain("Alpha summary body.");
    expect(parsed.body).toContain("## Notes");
    expect(parsed.body).toContain("<!-- openclaw:human:start -->");
    await expect(fs.readFile(path.join(rootDir, "index.md"), "utf8")).resolves.toContain(
      "[Alpha Synthesis](syntheses/alpha-synthesis.md)",
    );
  });

  it.each([
    {
      name: "syntax-error",
      frontmatterLines: [
        "pageType: synthesis",
        "id: synthesis.conflicted",
        "sourceIds:",
        '  - **MEMORY.md line 235**:"some quoted, value"',
      ],
      error: "Unexpected scalar",
    },
    {
      name: "sequence-root",
      frontmatterLines: ["- pageType: synthesis", "  id: synthesis.conflicted"],
      error: "Wiki frontmatter must be a YAML mapping",
    },
  ])(
    "rejects a malformed write target without replacing its metadata ($name) (#96125)",
    async ({ frontmatterLines, error }) => {
      const { rootDir, config } = await createVault();
      await fs.mkdir(path.join(rootDir, "syntheses"), { recursive: true });
      const targetPath = path.join(rootDir, "syntheses", "conflicted.md");
      const original = `---\n${frontmatterLines.join("\n")}\n---\n\n# Conflicted\n\nKeep this body.`;
      await fs.writeFile(targetPath, original, "utf8");

      await expect(
        applyMemoryWikiMutation({
          config,
          mutation: {
            op: "create_synthesis",
            title: "Conflicted",
            body: "Replacement body.",
            sourceIds: ["source.new"],
          },
        }),
      ).rejects.toThrow(error);
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe(original);
    },
  );

  it("updates page metadata without overwriting existing human notes", async () => {
    const { rootDir, config } = await createVault();

    const targetPath = await writeEntity(
      rootDir,
      "Alpha",
      {
        sourceIds: ["source.old"],
        confidence: 0.3,
      },
      "# Alpha\n\n## Notes\n<!-- openclaw:human:start -->\nkeep this note\n<!-- openclaw:human:end -->\n",
    );

    const metadata = {
      sourceIds: ["source.new"],
      claims: [
        {
          id: "claim.alpha.status",
          text: "Alpha is still active for existing tenants.",
          status: "contested",
          evidence: [{ sourceId: "source.new", lines: "4-9" }],
        },
      ],
      contradictions: ["Conflicts with source.beta"],
      questions: ["Is Alpha still active?"],
    };
    const result = await applyMemoryWikiMutation({
      config,
      mutation: {
        op: "update_metadata",
        lookup: "entity.alpha",
        ...structuredClone(metadata),
        confidence: null,
        status: "review",
      },
    });

    expect(result).toMatchObject({
      changed: true,
      pagePath: "entities/alpha.md",
      compile: { pageCounts: { entity: 1 } },
    });

    const updated = await fs.readFile(targetPath, "utf8");
    const parsed = parseWikiMarkdown(updated);

    expect(parsed.frontmatter).toMatchObject({
      pageType: "entity",
      id: "entity.alpha",
      title: "Alpha",
      ...metadata,
      claims: metadata.claims.map((claim) => expect.objectContaining(claim)),
      status: "review",
    });
    expect(parsed.frontmatter).not.toHaveProperty("confidence");
    expect(parsed.body).toContain("keep this note");
    expect(parsed.body).toContain("<!-- openclaw:human:start -->");
    await expect(
      fs.readFile(path.join(rootDir, "entities", "index.md"), "utf8"),
    ).resolves.toContain("[Alpha](alpha.md)");
  });

  it("preserves disjoint metadata updates from concurrent agent turns", async () => {
    const { rootDir, config } = await createVault();
    const targetPath = await writeEntity(rootDir, "Shared");

    await Promise.all(
      [
        { sourceIds: ["source.concurrent"] },
        { questions: ["Which agent owns the next action?"] },
        { confidence: 0.9 },
        { status: "review" },
      ].map((metadata) =>
        applyMemoryWikiMutation({
          config,
          mutation: { op: "update_metadata", lookup: "entity.shared", ...metadata },
        }),
      ),
    );

    const parsed = parseWikiMarkdown(await fs.readFile(targetPath, "utf8"));
    expect(parsed.frontmatter).toMatchObject({
      sourceIds: ["source.concurrent"],
      questions: ["Which agent owns the next action?"],
      confidence: 0.9,
      status: "review",
    });
  });
});
