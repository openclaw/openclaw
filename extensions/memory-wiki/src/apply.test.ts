import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyMemoryWikiMutation,
  computePromotionReadiness,
  PROMOTION_CONFIDENCE_THRESHOLD,
  PROMOTION_RECALL_THRESHOLD,
} from "./apply.js";
import { parseWikiMarkdown, renderWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

describe("applyMemoryWikiMutation", () => {
  it("creates synthesis pages with managed summary blocks and refreshed indexes", async () => {
    const { rootDir, config } = await createVault({ prefix: "memory-wiki-apply-" });

    const result = await applyMemoryWikiMutation({
      config,
      mutation: {
        op: "create_synthesis",
        title: "Alpha Synthesis",
        body: "Alpha summary body.",
        sourceIds: ["source.alpha", "source.beta"],
        claims: [
          {
            id: "claim.alpha.postgres",
            text: "Alpha uses PostgreSQL for production writes.",
            status: "supported",
            confidence: 0.86,
            evidence: [
              {
                sourceId: "source.alpha",
                lines: "12-18",
                weight: 0.9,
              },
            ],
          },
        ],
        contradictions: ["Needs a better primary source"],
        questions: ["What changed after launch?"],
        confidence: 0.7,
      },
    });

    expect(result.changed).toBe(true);
    expect(result.pagePath).toBe("syntheses/alpha-synthesis.md");
    expect(result.pageId).toBe("synthesis.alpha-synthesis");
    expect(result.compile.pageCounts.synthesis).toBe(1);

    const page = await fs.readFile(path.join(rootDir, result.pagePath), "utf8");
    const parsed = parseWikiMarkdown(page);

    expect(parsed.frontmatter).toMatchObject({
      pageType: "synthesis",
      id: "synthesis.alpha-synthesis",
      title: "Alpha Synthesis",
      sourceIds: ["source.alpha", "source.beta"],
      claims: [
        {
          id: "claim.alpha.postgres",
          text: "Alpha uses PostgreSQL for production writes.",
          status: "supported",
          confidence: 0.86,
          evidence: [
            {
              sourceId: "source.alpha",
              lines: "12-18",
              weight: 0.9,
            },
          ],
        },
      ],
      contradictions: ["Needs a better primary source"],
      questions: ["What changed after launch?"],
      confidence: 0.7,
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

  it("updates page metadata without overwriting existing human notes", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-apply-",
    });

    const targetPath = path.join(rootDir, "entities", "alpha.md");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(
      targetPath,
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.alpha",
          title: "Alpha",
          sourceIds: ["source.old"],
          confidence: 0.3,
        },
        body: `# Alpha

## Notes
<!-- openclaw:human:start -->
keep this note
<!-- openclaw:human:end -->
`,
      }),
      "utf8",
    );

    const result = await applyMemoryWikiMutation({
      config,
      mutation: {
        op: "update_metadata",
        lookup: "entity.alpha",
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
        confidence: null,
        status: "review",
      },
    });

    expect(result.changed).toBe(true);
    expect(result.pagePath).toBe("entities/alpha.md");
    expect(result.compile.pageCounts.entity).toBe(1);

    const updated = await fs.readFile(targetPath, "utf8");
    const parsed = parseWikiMarkdown(updated);

    expect(parsed.frontmatter).toMatchObject({
      pageType: "entity",
      id: "entity.alpha",
      title: "Alpha",
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
      status: "review",
    });
    expect(parsed.frontmatter).not.toHaveProperty("confidence");
    expect(parsed.body).toContain("keep this note");
    expect(parsed.body).toContain("<!-- openclaw:human:start -->");
    await expect(
      fs.readFile(path.join(rootDir, "entities", "index.md"), "utf8"),
    ).resolves.toContain("[Alpha](entities/alpha.md)");
  });
});

describe("promotion_ready synthesis flag", () => {
  it("exposes threshold constants matching the task spec", () => {
    expect(PROMOTION_CONFIDENCE_THRESHOLD).toBe(0.8);
    expect(PROMOTION_RECALL_THRESHOLD).toBe(3);
  });

  it("computePromotionReadiness requires BOTH confidence >= 0.8 AND recallCount >= 3", () => {
    expect(computePromotionReadiness({ confidence: 0.9, recallCount: 5 })).toBe(true);
    expect(computePromotionReadiness({ confidence: 0.8, recallCount: 3 })).toBe(true);
    expect(computePromotionReadiness({ confidence: 0.79, recallCount: 5 })).toBe(false);
    expect(computePromotionReadiness({ confidence: 0.9, recallCount: 2 })).toBe(false);
    expect(computePromotionReadiness({ confidence: null, recallCount: 5 })).toBe(false);
    expect(computePromotionReadiness({ confidence: 0.9, recallCount: null })).toBe(false);
  });

  it("flags a created synthesis that meets both thresholds", async () => {
    const { rootDir, config } = await createVault({ prefix: "memory-wiki-promotion-" });
    const result = await applyMemoryWikiMutation({
      config,
      mutation: {
        op: "create_synthesis",
        title: "Promote Alpha",
        body: "Alpha promotion summary.",
        sourceIds: ["source.alpha"],
        confidence: 0.9,
        recallCount: 5,
      },
    });
    expect(result.changed).toBe(true);
    const page = await fs.readFile(path.join(rootDir, result.pagePath), "utf8");
    const parsed = parseWikiMarkdown(page);
    expect(parsed.frontmatter).toMatchObject({
      pageType: "synthesis",
      confidence: 0.9,
      recallCount: 5,
      promotion_ready: true,
    });
  });

  it("does not flag a synthesis with high confidence but low recall count", async () => {
    const { rootDir, config } = await createVault({ prefix: "memory-wiki-promotion-" });
    const result = await applyMemoryWikiMutation({
      config,
      mutation: {
        op: "create_synthesis",
        title: "Almost Alpha",
        body: "Not yet ready.",
        sourceIds: ["source.alpha"],
        confidence: 0.9,
        recallCount: 2,
      },
    });
    const page = await fs.readFile(path.join(rootDir, result.pagePath), "utf8");
    const parsed = parseWikiMarkdown(page);
    expect(parsed.frontmatter).not.toHaveProperty("promotion_ready");
  });

  it("does not flag a synthesis with high recall count but low confidence", async () => {
    const { rootDir, config } = await createVault({ prefix: "memory-wiki-promotion-" });
    const result = await applyMemoryWikiMutation({
      config,
      mutation: {
        op: "create_synthesis",
        title: "Popular Alpha",
        body: "Popular but unverified.",
        sourceIds: ["source.alpha"],
        confidence: 0.5,
        recallCount: 10,
      },
    });
    const page = await fs.readFile(path.join(rootDir, result.pagePath), "utf8");
    const parsed = parseWikiMarkdown(page);
    expect(parsed.frontmatter).not.toHaveProperty("promotion_ready");
  });

  it("does not flag non-synthesis pages even when thresholds are met", async () => {
    const { rootDir, config } = await createVault({ prefix: "memory-wiki-promotion-" });
    const targetPath = path.join(rootDir, "entities", "bravo.md");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(
      targetPath,
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.bravo",
          title: "Bravo",
          sourceIds: ["source.bravo"],
        },
        body: "# Bravo\n\nnotes\n",
      }),
      "utf8",
    );
    await applyMemoryWikiMutation({
      config,
      mutation: {
        op: "update_metadata",
        lookup: "entity.bravo",
        confidence: 0.95,
        recallCount: 7,
      },
    });
    const updated = await fs.readFile(targetPath, "utf8");
    const parsed = parseWikiMarkdown(updated);
    expect(parsed.frontmatter).not.toHaveProperty("promotion_ready");
  });

  it("flips the flag on across updates when thresholds get crossed", async () => {
    const { rootDir, config } = await createVault({ prefix: "memory-wiki-promotion-" });
    const created = await applyMemoryWikiMutation({
      config,
      mutation: {
        op: "create_synthesis",
        title: "Rising Alpha",
        body: "Rising.",
        sourceIds: ["source.alpha"],
        confidence: 0.5,
        recallCount: 1,
      },
    });
    const absolutePath = path.join(rootDir, created.pagePath);
    expect(
      parseWikiMarkdown(await fs.readFile(absolutePath, "utf8")).frontmatter,
    ).not.toHaveProperty("promotion_ready");

    await applyMemoryWikiMutation({
      config,
      mutation: {
        op: "update_metadata",
        lookup: "synthesis.rising-alpha",
        confidence: 0.85,
        recallCount: 4,
      },
    });
    expect(parseWikiMarkdown(await fs.readFile(absolutePath, "utf8")).frontmatter).toMatchObject({
      promotion_ready: true,
    });

    await applyMemoryWikiMutation({
      config,
      mutation: {
        op: "update_metadata",
        lookup: "synthesis.rising-alpha",
        confidence: 0.6,
      },
    });
    expect(
      parseWikiMarkdown(await fs.readFile(absolutePath, "utf8")).frontmatter,
    ).not.toHaveProperty("promotion_ready");
  });
});
