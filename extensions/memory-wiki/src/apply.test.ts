import { describe, expect, it } from "vitest";
import {
  applyMemoryWikiMutation as apply,
  normalizeMemoryWikiMutationInput as normalize,
} from "./apply.js";
import { parseWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();
function mutate(config: Parameters<typeof apply>[0]["config"], mutation: unknown) {
  return apply({ config, mutation: normalize(mutation) });
}

const synthesisInput = { title: "Alpha Synthesis", body: "Summary.", sourceIds: ["source.alpha"] };

describe("applyMemoryWikiMutation", () => {
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
      const result = await mutate(config, {
        ...(update
          ? { op: "metadata", lookup: id, confidence: null, status: "review" }
          : { op: "synthesis", ...synthesisInput, confidence: "0.7" }),
        ...structuredClone(metadata),
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
      await expect(read(update ? "entities/index.md" : "index.md")).resolves.toContain(
        update ? "[Alpha](alpha.md)" : "[Alpha Synthesis](syntheses/alpha-synthesis.md)",
      );
      if (update) {
        expect(parsed.frontmatter).not.toHaveProperty("confidence");
        expect(parsed.body).toContain("keep this note");
      } else {
        expect(parsed.body).toContain("## Summary");
        expect(parsed.body).toContain("<!-- openclaw:wiki:generated:start -->");
        expect(parsed.body).toContain(synthesisInput.body);
        expect(parsed.body).toContain("## Notes");
        await mutate(config, { op: "metadata", lookup: id, status: "review" });
        await mutate(config, { op: "synthesis", ...synthesisInput, body: "Refreshed summary." });
        const refreshed = parseWikiMarkdown(await read(target));
        expect(refreshed.frontmatter).toMatchObject({ status: "review", confidence: 0.7 });
        await mutate(config, { op: "synthesis", ...synthesisInput, status: "stale" });
        expect(parseWikiMarkdown(await read(target)).frontmatter.status).toBe("stale");
      }
    },
  );

  it.each([
    [
      'pageType: synthesis\nid: synthesis.conflicted\nsourceIds:\n  - **MEMORY.md line 235**:"some quoted, value"',
      "Unexpected scalar",
    ],
    [
      "- pageType: synthesis\n  id: synthesis.conflicted",
      "Wiki frontmatter must be a YAML mapping",
    ],
  ])("preserves malformed write targets: %s (#96125)", async (frontmatter, error) => {
    const { config, write, read } = await createVault();
    const target = "syntheses/conflicted.md";
    const original = "---\n" + frontmatter + "\n---\n\n# Conflicted\n\nKeep this body.";
    await write(target, original);
    await expect(
      mutate(config, {
        op: "create_synthesis",
        ...synthesisInput,
        title: "Conflicted",
      }),
    ).rejects.toThrow(error);
    await expect(read(target)).resolves.toBe(original);
  });

  it("preserves disjoint metadata updates from concurrent agent turns", async () => {
    const { config, page, read } = await createVault();
    const target = "entities/shared.md";
    await page(target, { pageType: "entity", id: "entity.shared", title: "Shared" });

    await Promise.all(
      [{ questions: ["Which agent owns the next action?"] }, { confidence: "0.9" }].map(
        (metadata) =>
          mutate(config, { op: "update_metadata", lookup: "entity.shared", ...metadata }),
      ),
    );

    const parsed = parseWikiMarkdown(await read(target));
    expect(parsed.frontmatter).toMatchObject({
      questions: ["Which agent owns the next action?"],
      confidence: 0.9,
    });
  });
});
