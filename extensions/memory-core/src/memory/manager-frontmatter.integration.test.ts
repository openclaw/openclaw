import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { MEMORY_CHUNKING_VERSION } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it } from "vitest";
import type { PromotionCandidate } from "../short-term-promotion-types.js";
import { applyShortTermPromotions } from "../short-term-promotion.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory frontmatter production path", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it("excludes metadata across indexing, upgrade, and promotion", async () => {
    const relativePath = "memory/2026-09-05.md";
    const sourcePath = path.join(fixture.paths.workspace, relativePath);
    await fs.writeFile(
      sourcePath,
      [
        "---",
        'title: "Daily Notes — 2026-09-05"',
        "date: 2026-09-05",
        "type: daily",
        "tags: [memory, daily]",
        "status: active",
        "---",
        "# 2026-09-05",
        "Durable body content.",
      ].join("\n"),
    );

    const manager = await fixture.getFreshManager(
      fixture.createConfig({ provider: "none", sources: ["memory"], vectorEnabled: false }),
    );
    await manager.sync({ reason: "frontmatter-live-proof", force: true });
    const db = Reflect.get(manager, "db") as DatabaseSync;
    const indexed = db
      .prepare(
        `SELECT start_line AS startLine, end_line AS endLine, text
         FROM memory_index_chunks
         WHERE path = ? AND source = 'memory'
         ORDER BY start_line`,
      )
      .all(relativePath) as Array<{ startLine: number; endLine: number; text: string }>;
    expect(indexed).toEqual([
      { startLine: 8, endLine: 9, text: "# 2026-09-05\nDurable body content." },
    ]);

    const metaRow = db
      .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_index_meta_v1'")
      .get() as { value: string };
    const legacyMeta = {
      ...(JSON.parse(metaRow.value) as Record<string, unknown>),
      chunkingVersion: MEMORY_CHUNKING_VERSION - 1,
    };
    db.prepare("UPDATE memory_index_meta SET value = ? WHERE key = 'memory_index_meta_v1'").run(
      JSON.stringify(legacyMeta),
    );
    await manager.sync({ reason: "frontmatter-live-proof-upgrade" });
    const upgradedMeta = db
      .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_index_meta_v1'")
      .get() as { value: string };
    const upgradedVersion = (JSON.parse(upgradedMeta.value) as { chunkingVersion: number })
      .chunkingVersion;
    expect(upgradedVersion).toBe(MEMORY_CHUNKING_VERSION);

    const candidate: PromotionCandidate = {
      key: "memory:frontmatter-live-proof",
      path: relativePath,
      startLine: 6,
      endLine: 6,
      source: "memory",
      snippet: "status: active",
      recallCount: 3,
      signalCount: 3,
      avgScore: 0.95,
      maxScore: 0.95,
      uniqueQueries: 2,
      firstRecalledAt: "2026-09-05T00:00:00.000Z",
      lastRecalledAt: "2026-09-05T00:00:00.000Z",
      ageDays: 0,
      score: 0.95,
      recallDays: ["2026-09-05"],
      conceptTags: [],
      components: {
        frequency: 1,
        relevance: 1,
        diversity: 1,
        recency: 1,
        consolidation: 1,
        conceptual: 1,
      },
    };
    const promotion = await applyShortTermPromotions({
      agentId: "main",
      workspaceDir: fixture.paths.workspace,
      candidates: [candidate],
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
    });
    expect(promotion.applied).toBe(0);
    expect(promotion.rejectedCandidates[0]?.category).toBe("source rehydration");

    const memoryText = await fs
      .readFile(path.join(fixture.paths.workspace, "MEMORY.md"), "utf8")
      .catch(() => "");
    expect(memoryText).not.toContain("status: active");

    if (process.env.OPENCLAW_FRONTMATTER_PROOF === "1") {
      process.stdout.write(
        `${JSON.stringify({
          indexed,
          metadataExcluded: indexed.every((row) => !row.text.includes("status: active")),
          upgrade: {
            from: MEMORY_CHUNKING_VERSION - 1,
            to: upgradedVersion,
          },
          promotion: {
            applied: promotion.applied,
            rejectedAs: promotion.rejectedCandidates[0]?.category,
            durableMemoryContainsMetadata: memoryText.includes("status: active"),
          },
        })}\n`,
      );
    }
  });
});
