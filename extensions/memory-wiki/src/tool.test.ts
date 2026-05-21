import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { lintMemoryWikiVault } from "./lint.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import {
  createWikiApplyTool,
  createWikiLintTool,
  createWikiRecordReceiptTool,
  createWikiStatusTool,
} from "./tool.js";

const syncMemoryWikiImportedSourcesMock = vi.hoisted(() => vi.fn());

vi.mock("./source-sync.js", () => ({
  syncMemoryWikiImportedSources: syncMemoryWikiImportedSourcesMock,
}));

function asSchemaObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected JSON schema object");
  }
  return value as Record<string, unknown>;
}

describe("memory-wiki tools", () => {
  const harness = createMemoryWikiTestHarness();

  beforeEach(() => {
    syncMemoryWikiImportedSourcesMock.mockReset();
    syncMemoryWikiImportedSourcesMock.mockResolvedValue({
      importedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      removedCount: 0,
      artifactCount: 0,
      workspaces: 0,
      pagePaths: [],
      indexesRefreshed: false,
      indexUpdatedFiles: [],
      indexRefreshReason: "no-import-changes",
    });
  });

  it("keeps wiki_status pure read", async () => {
    const { config } = await harness.createVault({ initialize: true });
    const tool = createWikiStatusTool(config);

    const result = await tool.execute("status-call", {});

    expect(syncMemoryWikiImportedSourcesMock).not.toHaveBeenCalled();
    expect(asSchemaObject(result.details)).toMatchObject({
      vaultExists: true,
    });
  });

  it("records memory receipts through a model-facing tool", async () => {
    const { rootDir, config } = await harness.createVault({ initialize: true });
    const tool = createWikiRecordReceiptTool(config);

    const result = await tool.execute("receipt-call", {
      run_id: "run-123",
      task: "Verify memory wiki receipt tool",
      memory_preflight: {
        performed: true,
        wiki_injectable: true,
        reason_if_not: null,
        files_read: [".openclaw-wiki/cache/agent-digest.json"],
        claims_used: ["claim.alpha"],
      },
      decisions_influenced_by_memory: ["Used claim.alpha to avoid guessing."],
      writeback: {
        performed: false,
        paths: [],
      },
    });

    const details = asSchemaObject(result.details);
    expect(details).toMatchObject({
      recorded: true,
      runId: "run-123",
      logPath: ".openclaw-wiki/telemetry/memory-receipts.jsonl",
    });
    await expect(
      fs.readFile(
        path.join(rootDir, ".openclaw-wiki", "telemetry", "memory-receipts.jsonl"),
        "utf8",
      ),
    ).resolves.toContain('"run_id":"run-123"');
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
});
