import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lintMemoryWikiVault } from "./lint.js";
import { parseWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { createWikiApplyTool, createWikiLintTool } from "./tool.js";

describe("memory-wiki tools", () => {
  const harness = createMemoryWikiTestHarness();

  it("rejects non-object wiki_apply arguments without throwing a TypeError", async () => {
    const { config } = await harness.createVault({ initialize: true });
    const tool = createWikiApplyTool(config);

    for (const input of [null, undefined]) {
      await expect(tool.execute("malformed", input)).rejects.toThrow(
        'wiki mutation op must be one of "create_synthesis", "update_metadata"',
      );
    }
  });

  async function createApplyFixture() {
    const { rootDir, config } = await harness.createVault({ initialize: true });
    const pagePath = path.join(rootDir, "entities", "alpha.md");
    const original =
      "---\npageType: entity\nid: entity.alpha\ntitle: Alpha\nstatus: active\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\n\n# Alpha\n\nKeep this human note.\n";
    await fs.writeFile(pagePath, original, "utf8");
    return { tool: createWikiApplyTool(config), pagePath, original };
  }

  it("applies supported metadata operation update_metadata", async () => {
    const { tool, pagePath } = await createApplyFixture();
    const result = await tool.execute("valid-operation", {
      op: "update_metadata",
      lookup: "entity.alpha",
      status: "review",
    });
    const page = parseWikiMarkdown(await fs.readFile(pagePath, "utf8"));

    expect(result.details).toMatchObject({ changed: true, operation: "update_metadata" });
    expect(page.frontmatter.status).toBe("review");
    expect(page.body).toContain("Keep this human note.");
  });

  it("discloses complete-list replacements, clears, and preserves omitted metadata", async () => {
    const { tool, pagePath } = await createApplyFixture();
    const original = parseWikiMarkdown(await fs.readFile(pagePath, "utf8"));
    const lists = {
      claims: Array.from({ length: 17 }, (_, index) => ({ text: `Fact ${index}` })),
      questions: ["Question A", "Question B", "Question C"],
      contradictions: ["Conflict A", "Conflict B", "Conflict C"],
      sourceIds: ["source.a", "source.b", "source.c"],
    };
    await fs.writeFile(
      pagePath,
      `---\n${Object.entries({ ...original.frontmatter, ...lists })
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
        .join("\n")}\n---\n${original.body}`,
    );
    const replacement = {
      claims: [{ text: "Replacement fact" }],
      questions: ["New question"],
      contradictions: ["New conflict"],
      sourceIds: ["source.new"],
    };
    const result = await tool.execute("replace-lists", {
      op: "update_metadata",
      lookup: "entity.alpha",
      ...replacement,
    });
    expect(result.details).toMatchObject({
      metadataListChanges: {
        claims: { before: 17, after: 1 },
        questions: { before: 3, after: 1 },
        contradictions: { before: 3, after: 1 },
        sourceIds: { before: 3, after: 1 },
      },
    });
    expect(result.content).toContainEqual({
      type: "text",
      text: expect.stringContaining("Replaced metadata lists:"),
    });
    expect(result.content).toContainEqual({
      type: "text",
      text: expect.stringContaining("claims 17 -> 1"),
    });
    const updated = parseWikiMarkdown(await fs.readFile(pagePath, "utf8"));
    expect(updated.frontmatter).toMatchObject(replacement);
    expect(updated.body).toContain("Keep this human note.");
    const scalar = await tool.execute("scalar-only", {
      op: "metadata",
      lookup: "entity.alpha",
      status: "review",
    });
    expect(scalar.details).not.toHaveProperty("metadataListChanges");
    expect(parseWikiMarkdown(await fs.readFile(pagePath, "utf8")).frontmatter).toMatchObject(
      replacement,
    );
    const cleared = await tool.execute("clear-lists", {
      op: "update_metadata",
      lookup: "entity.alpha",
      claims: [],
      questions: [],
      contradictions: [],
      sourceIds: [],
    });
    expect(cleared.details).toMatchObject({
      metadataListChanges: {
        claims: { before: 1, after: 0 },
        questions: { before: 1, after: 0 },
        contradictions: { before: 1, after: 0 },
        sourceIds: { before: 1, after: 0 },
      },
    });
    const empty = parseWikiMarkdown(await fs.readFile(pagePath, "utf8"));
    expect(empty.frontmatter.sourceIds).toEqual([]);
    for (const key of ["claims", "questions", "contradictions"]) {
      expect(empty.frontmatter).not.toHaveProperty(key);
    }
  });

  it("keeps wiki pages unchanged for out-of-range claim confidence", async () => {
    const { tool, pagePath, original } = await createApplyFixture();

    await expect(
      tool.execute("invalid-claim-confidence", {
        op: "update_metadata",
        lookup: "entity.alpha",
        claims: [{ text: "Alpha fact", confidence: 999 }],
      }),
    ).rejects.toThrow("claims[0].confidence must be a number between 0 and 1; received 999.");
    await expect(fs.readFile(pagePath, "utf8")).resolves.toBe(original);
  });

  it("returns tool-safe relative report paths from wiki_lint", async () => {
    const { rootDir, config } = await harness.createVault({ initialize: true });
    await fs.mkdir(path.join(rootDir, "syntheses"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "syntheses", "bad.md"),
      "---\nid: synth-bad\npageType: synthesis\ntitle: Bad Page\n---\n\nThis links to [[Missing Page]].",
      "utf8",
    );

    const result = await createWikiLintTool(config).execute("lint-call", {});
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    const details = result.details;

    expect(text).toContain("Report: reports/lint.md");
    expect(text).not.toContain(rootDir);
    expect(details).toMatchObject({
      reportPath: "reports/lint.md",
      issuesByCategory: {
        links: expect.arrayContaining([expect.objectContaining({ code: "broken-wikilink" })]),
      },
    });
    expect(details).not.toHaveProperty("vaultRoot");
    expect(JSON.stringify(details)).not.toContain(rootDir);

    const lintResult = await lintMemoryWikiVault(config);
    expect(path.isAbsolute(lintResult.reportPath)).toBe(true);
    expect(lintResult.reportPath).toContain(rootDir);
  });
});
