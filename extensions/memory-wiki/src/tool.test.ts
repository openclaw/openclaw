// Memory Wiki tests cover tool plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ResolvedMemoryWikiConfig } from "./config.js";
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

function unionLiteralValues(schema: Record<string, unknown>): string[] {
  const variants = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(variants)) {
    throw new Error("Expected union schema variants");
  }
  return variants
    .map((variant) => asSchemaObject(variant).const)
    .filter((value): value is string => typeof value === "string")
    .toSorted();
}

describe("memory-wiki tools", () => {
  const harness = createMemoryWikiTestHarness();

  it("accepts CLI-style operation aliases in wiki_apply schema", () => {
    const tool = createWikiApplyTool({} as ResolvedMemoryWikiConfig);
    const applyProperties = asSchemaObject(asSchemaObject(tool.parameters).properties);
    const opSchema = asSchemaObject(applyProperties.op);

    expect(unionLiteralValues(opSchema)).toEqual([
      "concept",
      "create_concept",
      "create_entity",
      "create_synthesis",
      "entity",
      "metadata",
      "synthesis",
      "update_metadata",
    ]);
  });

  it("exposes entity metadata inputs in wiki_apply schema", () => {
    const tool = createWikiApplyTool({} as ResolvedMemoryWikiConfig);
    const applyProperties = asSchemaObject(asSchemaObject(tool.parameters).properties);
    const relationshipsSchema = asSchemaObject(applyProperties.relationships);
    const relationshipProperties = asSchemaObject(
      asSchemaObject(relationshipsSchema.items).properties,
    );

    expect(Object.keys(applyProperties)).toEqual(
      expect.arrayContaining(["entityType", "canonicalId", "aliases", "relationships"]),
    );
    expect(Object.keys(relationshipProperties).toSorted()).toEqual([
      "confidence",
      "evidenceKind",
      "kind",
      "note",
      "privacyTier",
      "targetId",
      "targetPath",
      "targetTitle",
      "updatedAt",
      "weight",
    ]);
    expect(relationshipProperties.confidence).toEqual({ type: "number", minimum: 0, maximum: 1 });
  });

  it("allows provenance metadata in wiki_apply claim evidence", () => {
    const tool = createWikiApplyTool({} as ResolvedMemoryWikiConfig);
    const applyProperties = asSchemaObject(asSchemaObject(tool.parameters).properties);
    const claimsSchema = asSchemaObject(applyProperties.claims);
    const claimSchema = asSchemaObject(claimsSchema.items);
    const claimProperties = asSchemaObject(claimSchema.properties);
    const evidenceSchema = asSchemaObject(claimProperties.evidence);
    const evidenceArraySchema = asSchemaObject(evidenceSchema.items);
    const evidenceProperties = asSchemaObject(evidenceArraySchema.properties);

    expect(Object.keys(evidenceProperties).toSorted()).toEqual([
      "confidence",
      "kind",
      "lines",
      "note",
      "path",
      "privacyTier",
      "sourceId",
      "updatedAt",
      "weight",
    ]);
    expect(evidenceProperties.confidence).toEqual({ type: "number", minimum: 0, maximum: 1 });
  });

  it("rejects non-object wiki_apply arguments without throwing a TypeError", async () => {
    const { config } = await harness.createVault({ initialize: true });
    const tool = createWikiApplyTool(config);

    await expect(tool.execute("malformed-null", null)).rejects.toThrow(
      'wiki mutation op must be one of "create_synthesis", "create_concept", "create_entity", "update_metadata"',
    );
    await expect(tool.execute("malformed-undefined", undefined)).rejects.toThrow(
      'wiki mutation op must be one of "create_synthesis", "create_concept", "create_entity", "update_metadata"',
    );
  });

  async function createApplyFixture() {
    const { rootDir, config } = await harness.createVault({ initialize: true });
    const pagePath = path.join(rootDir, "entities", "alpha.md");
    const original = [
      "---",
      "pageType: entity",
      "id: entity.alpha",
      "title: Alpha",
      "status: active",
      "updatedAt: 2026-01-01T00:00:00.000Z",
      "---",
      "",
      "# Alpha",
      "",
      "Keep this human note.",
      "",
    ].join("\n");
    await fs.writeFile(pagePath, original, "utf8");
    return { tool: createWikiApplyTool(config), pagePath, original };
  }

  it.each(["synthesise", "update"])(
    "keeps wiki pages unchanged for unknown operation %s",
    async (op) => {
      const { tool, pagePath, original } = await createApplyFixture();
      const outcome = await tool
        .execute("unknown-operation", { op, lookup: "entity.alpha", status: "review" })
        .then(
          () => "accepted",
          () => "rejected",
        );

      expect(await fs.readFile(pagePath, "utf8")).toBe(original);
      expect(outcome).toBe("rejected");
    },
  );

  it.each(["update_metadata", "metadata"])(
    "applies supported metadata operation %s",
    async (op) => {
      const { tool, pagePath } = await createApplyFixture();
      const result = await tool.execute("valid-operation", {
        op,
        lookup: "entity.alpha",
        status: "review",
      });
      const page = parseWikiMarkdown(await fs.readFile(pagePath, "utf8"));

      expect(result.details).toMatchObject({ changed: true, operation: "update_metadata" });
      expect(page.frontmatter.status).toBe("review");
      expect(page.body).toContain("Keep this human note.");
    },
  );

  it.each([
    { op: "create_concept", dir: "concepts", pageType: "concept" },
    { op: "concept", dir: "concepts", pageType: "concept" },
    { op: "create_entity", dir: "entities", pageType: "entity" },
    { op: "entity", dir: "entities", pageType: "entity" },
  ])("creates lint-clean $pageType pages via wiki_apply op $op", async ({ op, dir, pageType }) => {
    const { rootDir, config } = await harness.createVault({ initialize: true });
    const tool = createWikiApplyTool(config);

    const result = await tool.execute("create-page", {
      op,
      title: "Gamma Page",
      body: "Gamma summary body.",
      sourceIds: ["source.gamma"],
      ...(pageType === "entity" ? { entityType: "project", aliases: ["gamma"] } : {}),
    });
    const page = parseWikiMarkdown(
      await fs.readFile(path.join(rootDir, dir, "gamma-page.md"), "utf8"),
    );

    expect(result.details).toMatchObject({
      changed: true,
      operation: `create_${pageType}`,
      pagePath: `${dir}/gamma-page.md`,
      pageId: `${pageType}.gamma-page`,
    });
    expect(page.frontmatter).toMatchObject({
      pageType,
      id: `${pageType}.gamma-page`,
      sourceIds: ["source.gamma"],
      ...(pageType === "entity" ? { entityType: "project", aliases: ["gamma"] } : {}),
    });

    const lint = await lintMemoryWikiVault(config);
    expect(lint.issues.filter((issue) => issue.path === `${dir}/gamma-page.md`)).toEqual([]);
  });

  it("clears stored entity lists through wiki_apply with explicit empty arrays", async () => {
    const { rootDir, config } = await harness.createVault({ initialize: true });
    const tool = createWikiApplyTool(config);

    await tool.execute("create-entity", {
      op: "create_entity",
      title: "Delta Entity",
      body: "Delta entity body.",
      sourceIds: ["source.delta"],
      aliases: ["delta-old"],
      relationships: [{ targetId: "entity.target", kind: "relates-to", confidence: 0.5 }],
    });
    await tool.execute("clear-entity", {
      op: "create_entity",
      title: "Delta Entity",
      body: "Delta entity body refreshed.",
      sourceIds: ["source.delta"],
      aliases: [],
      relationships: [],
    });

    const page = parseWikiMarkdown(
      await fs.readFile(path.join(rootDir, "entities", "delta-entity.md"), "utf8"),
    );
    expect(page.frontmatter.aliases).toEqual([]);
    expect(page.frontmatter.relationships).toEqual([]);

    const lint = await lintMemoryWikiVault(config);
    expect(lint.issues.filter((issue) => issue.path === "entities/delta-entity.md")).toEqual([]);
  });

  it.each([-0.5, 999])(
    "keeps wiki pages unchanged for out-of-range claim confidence %s",
    async (confidence) => {
      const { tool, pagePath, original } = await createApplyFixture();

      await expect(
        tool.execute("invalid-claim-confidence", {
          op: "update_metadata",
          lookup: "entity.alpha",
          claims: [{ text: "Alpha fact", confidence }],
        }),
      ).rejects.toThrow(
        `claims[0].confidence must be a number between 0 and 1; received ${confidence}.`,
      );
      await expect(fs.readFile(pagePath, "utf8")).resolves.toBe(original);
    },
  );

  it("returns tool-safe relative report paths from wiki_lint", async () => {
    const { rootDir, config } = await harness.createVault({ initialize: true });
    await fs.mkdir(path.join(rootDir, "syntheses"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "syntheses", "bad.md"),
      [
        "---",
        "id: synth-bad",
        "pageType: synthesis",
        "title: Bad Page",
        "---",
        "",
        "This links to [[Missing Page]].",
      ].join("\n"),
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
