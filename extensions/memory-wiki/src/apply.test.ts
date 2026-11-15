import { fromMarkdown } from "mdast-util-from-markdown";
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

const synthesis = { title: "Alpha *Synthesis* #", body: "Summary.", sourceIds: ["source.alpha"] };

describe("applyMemoryWikiMutation", () => {
  it.each([false, true])("persists page state (update: %s)", async (update) => {
    const { config, write, read } = await createVault();
    const kind = update ? "entity" : "synthesis";
    const title = update ? "Alpha" : synthesis.title;
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
      const original =
        "---\n# provenance: imported from the OKF export\npageType: entity\nid: entity.alpha\ntitle: Alpha\nsourceIds: [source.old]\nconfidence: 0.3\nbuild: 00123\nbig: 12345678901234567890\ntags:\n  - alpha # team tag\n---\n\n# Alpha\n\n## Notes\n<!-- openclaw:human:start -->\nkeep this note\n<!-- openclaw:human:end -->\n";
      await write(target, original);
    }
    const result = await mutate(config, {
      ...(update
        ? { op: "metadata", lookup: id, confidence: null, status: "review" }
        : { op: "synthesis", ...synthesis, confidence: "0.7" }),
      ...structuredClone(metadata),
    });
    expect(result).toMatchObject({
      changed: true,
      pagePath: target,
      pageId: id,
      compile: { pageCounts: { [kind]: 1 } },
    });
    const raw = await read(target);
    const parsed = parseWikiMarkdown(raw);
    const heading = fromMarkdown(parsed.body).children[0];
    expect(heading).toMatchObject({ type: "heading", depth: 1, children: [{ value: title }] });
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
      update ? "[Alpha](alpha.md)" : "[Alpha \\*Synthesis\\* \\#](syntheses/alpha-synthesis.md)",
    );
    if (update) {
      expect(raw).toContain("# provenance: imported from the OKF export\n");
      expect(raw).toContain(
        "build: 00123\nbig: 12345678901234567890\ntags:\n  - alpha # team tag\n",
      );
      expect(parsed.frontmatter).not.toHaveProperty("confidence");
      expect(parsed.body).toContain("keep this note");
    } else {
      expect(parsed.body).toContain("## Summary");
      expect(parsed.body).toContain("<!-- openclaw:wiki:generated:start -->");
      expect(parsed.body).toContain(synthesis.body);
      expect(parsed.body).toContain("## Notes");
      await mutate(config, { op: "metadata", lookup: id, status: "review" });
      await mutate(config, { op: "synthesis", ...synthesis, body: "Refreshed summary." });
      const refreshed = parseWikiMarkdown(await read(target));
      expect(refreshed.frontmatter).toMatchObject({ status: "review", confidence: 0.7 });
      await mutate(config, { op: "synthesis", ...synthesis, status: "stale" });
      expect(parseWikiMarkdown(await read(target)).frontmatter.status).toBe("stale");
    }
  });

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
    const mutation = { op: "create_synthesis", ...synthesis, title: "Conflicted" };
    await expect(mutate(config, mutation)).rejects.toThrow(error);
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
