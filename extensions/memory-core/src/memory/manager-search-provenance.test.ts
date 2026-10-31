import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "./embeddings.js";
import {
  createManagerIndexFixture,
  memoryIndexFixtureWriter,
} from "./manager-index.test-support.js";
import * as knnSubprocess from "./manager-search-knn.js";

const memory = await import("./index.js");

describe("memory search provenance enrichment", () => {
  const fixture = createManagerIndexFixture(memory);

  it.each([
    { name: "body keywords", query: "violet", vector: false },
    { name: "path keywords", query: "orchid", vector: false },
    { name: "exact paths", query: "orchid-0.md", vector: false },
    { name: "keyword fallback", query: "violet absentphrase", vector: false },
    { name: "KNN", query: "semantic needle", vector: true },
    { name: "embedding scan", query: "semantic needle", vector: false },
  ])("returns authoritative metadata through $name without main-thread SQL", async (entry) => {
    await fs.rm(path.join(fixture.paths.memory, "2026-01-12.md"));
    const paths = Array.from({ length: 32 }, (_, index) => `memory/orchid-${index}.md`);
    await Promise.all(
      paths.map((relPath, index) =>
        fs.writeFile(path.join(fixture.paths.workspace, relPath), `Alpha violet record ${index}.`),
      ),
    );
    const manager = await fixture.getPersistentManager(
      fixture.createConfig({ vectorEnabled: entry.vector }),
    );
    await manager.sync({ reason: "test" });
    const { db, provider } = manager as unknown as {
      db: DatabaseSync;
      provider: EmbeddingProvider;
    };
    const writer = memoryIndexFixtureWriter(manager);
    using embed = vi.spyOn(provider, "embed");
    embed.mockResolvedValue([1, 0, 0, 0]);
    writer.exec(`
      UPDATE memory_index_chunk_provenance
      SET origin_class = 'owner', session_kind = 'interactive', observed_at = 1234,
          supersedes_key = '  tea-preference  ';
      UPDATE memory_index_chunk_provenance SET origin_class = 'untrusted', session_kind = 'unknown'
      WHERE chunk_id IN (SELECT id FROM memory_index_chunks WHERE path = 'memory/orchid-1.md');
      PRAGMA ignore_check_constraints = ON;
      UPDATE memory_index_chunk_provenance SET origin_class = 'invalid'
      WHERE chunk_id IN (SELECT id FROM memory_index_chunks WHERE path = 'memory/orchid-2.md');
      UPDATE memory_index_chunk_provenance SET session_kind = 'invalid'
      WHERE chunk_id IN (SELECT id FROM memory_index_chunks WHERE path = 'memory/orchid-3.md');
      PRAGMA ignore_check_constraints = OFF;
      DELETE FROM memory_index_chunk_provenance
      WHERE chunk_id IN (SELECT id FROM memory_index_chunks WHERE path = 'memory/orchid-4.md');
      INSERT OR REPLACE INTO memory_index_chunk_recall_metadata (chunk_id, importance, triggers, project_key)
      SELECT id, 9, ' when flying ', ' github.com/openclaw/openclaw '
      FROM memory_index_chunks WHERE path = 'memory/orchid-0.md';
    `);

    using queries = vi.spyOn(db, "prepare");
    using knn = vi.spyOn(knnSubprocess, "searchMemoryVectorIndex");
    const results = await manager.search(entry.query, {
      lexicalOnly: entry.query !== "semantic needle",
      maxResults: entry.name === "exact paths" ? 1 : paths.length,
      minScore: 0,
    });
    const expectedPaths = entry.name === "exact paths" ? paths.slice(0, 1) : paths;
    expect(results.map((result) => result.path).toSorted()).toEqual(expectedPaths.toSorted());
    expect(results[0]).toMatchObject({
      path: paths[0],
      importance: 9,
      triggers: "when flying",
      projectKey: "github.com/openclaw/openclaw",
    });
    for (const result of results) {
      expect(result.snippet).toContain("Alpha violet record");
      if (paths.slice(2, 5).includes(result.path)) {
        expect(result).not.toHaveProperty("provenance");
      } else {
        expect(result.provenance).toEqual({
          originClass: result.path === paths[1] ? "untrusted" : "owner",
          sessionKind: result.path === paths[1] ? "unknown" : "interactive",
          observedAt: 1234,
          supersedesKey: "  tea-preference  ",
        });
      }
    }
    expect(queries).not.toHaveBeenCalled();
    if (entry.vector) {
      expect(knn).toHaveBeenCalledOnce();
      const result = await knn.mock.results[0]?.value;
      expect(result?.fallbackScanRequired).toBe(false);
      expect(result?.rows.length).toBeGreaterThan(0);
      expect(manager.status().vector?.storeAvailable).toBe(true);
    }
  });
});
