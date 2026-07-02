// Memory Wiki tests cover tool plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { lintMemoryWikiVault } from "./lint.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import {
  createWikiApplyTool,
  createWikiGetTool,
  createWikiLintTool,
  createWikiSearchTool,
  createWikiStatusTool,
} from "./tool.js";

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
      "create_synthesis",
      "metadata",
      "synthesis",
      "update_metadata",
    ]);
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

  it("rejects shared wiki_lint before report or log writes", async () => {
    const { rootDir, config } = await harness.createVault({ initialize: true });
    const logPath = path.join(rootDir, ".openclaw-wiki", "log.jsonl");
    const beforeLog = await fs.readFile(logPath, "utf8");
    const tool = createWikiLintTool(config, undefined, {
      agentSessionKey: "agent:main:telegram:group:team",
      agentChatType: "group",
    });

    const result = await tool.execute("lint-call-shared", {});

    expect(result.details).toEqual({
      action: "rejected",
      reason: "shared_session_explicit_only",
    });
    expect(result.content.find((part) => part.type === "text")?.text).toContain(
      "shared sessions cannot mutate",
    );
    await expect(fs.access(path.join(rootDir, "reports", "lint.md"))).rejects.toThrow();
    await expect(fs.readFile(logPath, "utf8")).resolves.toBe(beforeLog);
  });

  it("returns sanitized shared wiki_status before sync or vault metadata exposure", async () => {
    const { rootDir, config } = await harness.createVault({ initialize: true });
    const logPath = path.join(rootDir, ".openclaw-wiki", "log.jsonl");
    const beforeLog = await fs.readFile(logPath, "utf8");
    const tool = createWikiStatusTool(config, undefined, {
      agentSessionKey: "agent:main:telegram:group:team",
      agentChatType: "group",
    });

    const result = await tool.execute("status-call-shared", {});

    expect(result.details).toEqual({
      action: "rejected",
      reason: "shared_session_explicit_only",
    });
    expect(result.content.find((part) => part.type === "text")?.text).toContain(
      "limited in shared sessions",
    );
    expect(JSON.stringify(result)).not.toContain(rootDir);
    await expect(fs.readFile(logPath, "utf8")).resolves.toBe(beforeLog);
  });

  it("keeps shared wiki_search and wiki_get snapshot-only without source sync", async () => {
    const sourceDir = await harness.createTempDir("memory-wiki-unsafe-source-");
    const privateSourcePath = path.join(sourceDir, "private.md");
    await fs.writeFile(privateSourcePath, "# Private Source\n\nsync-only content\n", "utf8");
    const { rootDir, config } = await harness.createVault({
      initialize: false,
      config: {
        vaultMode: "unsafe-local",
        unsafeLocal: {
          allowPrivateMemoryCoreAccess: true,
          paths: [privateSourcePath],
        },
      },
    });
    const memoryContext = {
      agentSessionKey: "agent:main:telegram:group:team",
      agentChatType: "group",
    };
    const searchTool = createWikiSearchTool(config, undefined, memoryContext);
    const getTool = createWikiGetTool(config, undefined, memoryContext);

    const searchResult = await searchTool.execute("search-call-shared", {
      query: "sync-only",
    });
    const getResult = await getTool.execute("get-call-shared", {
      lookup: "source.private",
    });

    expect(searchResult.details).toEqual({ results: [] });
    expect(searchResult.content.find((part) => part.type === "text")?.text).toBe(
      "No wiki or memory results.",
    );
    expect(getResult.details).toEqual({ found: false });
    await expect(fs.access(path.join(rootDir, ".openclaw-wiki", "log.jsonl"))).rejects.toThrow();
    await expect(fs.access(path.join(rootDir, "sources"))).rejects.toThrow();
  });

  it("rejects shared wiki_apply before wiki page writes", async () => {
    const { rootDir, config } = await harness.createVault({ initialize: true });
    const logPath = path.join(rootDir, ".openclaw-wiki", "log.jsonl");
    const beforeLog = await fs.readFile(logPath, "utf8");
    const tool = createWikiApplyTool(config, undefined, {
      agentSessionKey: "agent:main:telegram:direct:alice",
      agentChatType: "group",
    });

    const result = await tool.execute("apply-call-shared", {
      op: "create_synthesis",
      title: "Shared Session Synthesis",
      body: "Shared session body.",
    });

    expect(result.details).toEqual({
      action: "rejected",
      reason: "shared_session_explicit_only",
    });
    expect(result.content.find((part) => part.type === "text")?.text).toContain(
      "shared sessions cannot mutate",
    );
    await expect(
      fs.access(path.join(rootDir, "syntheses", "shared-session-synthesis.md")),
    ).rejects.toThrow();
    await expect(fs.readFile(logPath, "utf8")).resolves.toBe(beforeLog);
  });
});
