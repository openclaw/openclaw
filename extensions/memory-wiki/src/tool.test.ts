import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lintMemoryWikiVault } from "./lint.js";
import { parseWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { createWikiApplyTool, createWikiLintTool } from "./tool.js";

function asSchemaObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected JSON schema object");
  }
  return value as Record<string, unknown>;
}

describe("memory-wiki tools", () => {
  const harness = createMemoryWikiTestHarness();

  it("rejects non-object wiki_apply arguments without throwing a TypeError", async () => {
    const { config } = await harness.createVault({ initialize: true });
    const tool = createWikiApplyTool(config);

    await expect(tool.execute("malformed-null", null)).rejects.toThrow(
      'wiki mutation op must be one of "create_synthesis", "update_metadata"',
    );
    await expect(tool.execute("malformed-undefined", undefined)).rejects.toThrow(
      'wiki mutation op must be one of "create_synthesis", "update_metadata"',
    );
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

    const tool = createWikiLintTool(config);
    const result = await tool.execute("lint-call", {});
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    const details = asSchemaObject(result.details);

    expect(text).toContain("Report: reports/lint.md");
    expect(text).not.toContain(rootDir);
    expect(details.reportPath).toBe("reports/lint.md");
    expect(details).not.toHaveProperty("vaultRoot");
    expect(JSON.stringify(details)).not.toContain(rootDir);
    expect(asSchemaObject(details.issuesByCategory).links).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "broken-wikilink" })]),
    );

    const lintResult = await lintMemoryWikiVault(config);
    expect(path.isAbsolute(lintResult.reportPath)).toBe(true);
    expect(lintResult.reportPath).toContain(rootDir);
  });
});
