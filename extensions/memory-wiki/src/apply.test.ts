import { describe, expect, it } from "vitest";
import { applyMemoryWikiMutation, normalizeMemoryWikiMutationInput } from "./apply.js";
import { parseWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

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

  it.each([false, true])(
    "persists metadata, indexes and human blocks (update: %s)",
    async (update) => {
      const { config, page, read } = await createVault();
      const kind = update ? "entity" : "synthesis";
      const title = update ? "Alpha" : synthesisInput.title;
      const id = update ? "entity.alpha" : "synthesis.alpha-synthesis";
      const target = update ? "entities/alpha.md" : "syntheses/alpha-synthesis.md";
      const metadata = {
        sourceIds: update ? ["source.new"] : ["source.alpha", "source.beta"],
        claims: [
          {
            id: "claim.alpha.status",
            text: "Alpha uses PostgreSQL.",
            status: update ? "contested" : "supported",
            ...(!update ? { confidence: 0.86 } : {}),
            evidence: [
              {
                sourceId: update ? "source.new" : "source.alpha",
                lines: "4-9",
                ...(!update ? { weight: 0.9 } : {}),
              },
            ],
          },
        ],
        contradictions: ["Conflicts with source.beta"],
        questions: ["Is Alpha still active?"],
      };
      if (update) {
        await page(
          target,
          { pageType: kind, id, title, sourceIds: ["source.old"], confidence: 0.3 },
          "# Alpha\n\n## Notes\n<!-- openclaw:human:start -->\nkeep this note\n<!-- openclaw:human:end -->\n",
        );
      }
      const result = await applyMemoryWikiMutation({
        config,
        mutation: update
          ? {
              op: "update_metadata",
              lookup: id,
              ...structuredClone(metadata),
              confidence: null,
              status: "review",
            }
          : {
              op: "create_synthesis",
              ...synthesisInput,
              ...structuredClone(metadata),
              confidence: 0.7,
            },
      });
      expect(result).toMatchObject({
        changed: true,
        pagePath: target,
        pageId: id,
        compile: { pageCounts: { [kind]: 1 } },
      });
      const parsed = parseWikiMarkdown(await read(target));
      expect(parsed.frontmatter).toMatchObject({
        pageType: kind,
        id,
        title,
        ...metadata,
        claims: metadata.claims.map((claim) => expect.objectContaining(claim)),
        status: update ? "review" : "active",
        ...(!update ? { confidence: 0.7 } : {}),
      });
      expect(parsed.body).toContain("<!-- openclaw:human:start -->");
      if (update) {
        expect(parsed.frontmatter).not.toHaveProperty("confidence");
        expect(parsed.body).toContain("keep this note");
      } else {
        expect(parsed.body).toContain("## Summary");
        expect(parsed.body).toContain("<!-- openclaw:wiki:generated:start -->");
        expect(parsed.body).toContain(synthesisInput.body);
        expect(parsed.body).toContain("## Notes");
      }
      await expect(read(update ? "entities/index.md" : "index.md")).resolves.toContain(
        update ? "[Alpha](alpha.md)" : "[Alpha Synthesis](syntheses/alpha-synthesis.md)",
      );
    },
  );

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
      const { config, write, read } = await createVault();
      const target = "syntheses/conflicted.md";
      const original = `---\n${frontmatterLines.join("\n")}\n---\n\n# Conflicted\n\nKeep this body.`;
      await write(target, original);

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
      await expect(read(target)).resolves.toBe(original);
    },
  );

  it("preserves disjoint metadata updates from concurrent agent turns", async () => {
    const { config, page, read } = await createVault();
    const target = "entities/shared.md";
    await page(target, { pageType: "entity", id: "entity.shared", title: "Shared" });

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

    const parsed = parseWikiMarkdown(await read(target));
    expect(parsed.frontmatter).toMatchObject({
      sourceIds: ["source.concurrent"],
      questions: ["Which agent owns the next action?"],
      confidence: 0.9,
      status: "review",
    });
  });
});
