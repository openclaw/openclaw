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
    const { config, write } = await harness.createVault({ initialize: true });
    const original =
      "---\npageType: entity\nid: entity.alpha\ntitle: Alpha\nstatus: active\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\n\n# Alpha\n\nKeep this human note.\n";
    const pagePath = await write("entities/alpha.md", original);
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
    const { rootDir, config, page } = await harness.createVault({ initialize: true });
    await page(
      "syntheses/bad.md",
      { id: "synth-bad", pageType: "synthesis", title: "Bad Page" },
      "This links to [[Missing Page]].",
    );

    const { content, details } = await createWikiLintTool(config).execute("lint-call", {});
    const text = content.find((part) => part.type === "text")?.text ?? "";

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
