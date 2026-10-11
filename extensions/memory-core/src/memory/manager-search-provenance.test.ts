import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { hashText } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import * as memoryRuntime from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "./embeddings.js";
import {
  createManagerIndexFixture,
  memoryIndexFixtureWriter,
} from "./manager-index.test-support.js";
import * as knnSubprocess from "./manager-search-knn-subprocess.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-core", { spy: true });

describe("memory search provenance enrichment", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it.each([false, true])(
    "refreshes same-text origins without embeddings (batch=%s)",
    async (batchEnabled) => {
      const content =
        "- Keep the amber notebook. <!-- trigger: amber notebook --> <!-- project: fixture/project -->\n";
      await fs.writeFile(path.join(fixture.paths.workspace, "MEMORY.md"), content);
      let originClass: "agent" | "untrusted" = "agent";
      const provenance = () => ({ fileHash: hashText(content), originClass, observedAt: 1 });
      const read = vi
        .spyOn(memoryRuntime, "readMemoryArtifactProvenance")
        .mockImplementation(async ({ relativePath }) =>
          relativePath === "MEMORY.md" ? provenance() : undefined,
        );
      const list = vi
        .spyOn(memoryRuntime, "listMemoryArtifactProvenance")
        .mockImplementation(async () => [{ relativePath: "MEMORY.md", provenance: provenance() }]);
      const config = fixture.createConfig({
        provider: batchEnabled ? "batch-wide-test" : "gemini",
        batchEnabled,
        cacheEnabled: false,
        vectorEnabled: false,
        sources: ["memory"],
      });
      try {
        const baseline = await fixture.getFreshManager(config);
        await baseline.sync({ reason: "session-start" });
        expect(baseline.status().batch?.enabled).toBe(batchEnabled);
        expect(
          await baseline.listTriggerCandidates({ activeProjectKeys: ["fixture/project"] }),
        ).toHaveLength(1);
        const beforeDb = memoryIndexFixtureWriter(baseline);
        const query =
          "SELECT id, text, embedding, updated_at FROM memory_index_chunks WHERE path = 'MEMORY.md'";
        const before = beforeDb.prepare(query).all();
        const beforeProvenance = beforeDb
          .prepare(
            "SELECT session_kind, observed_at, supersedes_key FROM memory_index_chunk_provenance WHERE chunk_id IN (SELECT id FROM memory_index_chunks WHERE path = 'MEMORY.md')",
          )
          .all();
        const embeddingCalls = fixture.provider.embedBatchCalls;
        const batchCalls = fixture.provider.providerRuntimeBatchCalls.length;
        await baseline.close();

        // The artifact-record owner can reclassify a real replacement without
        // changing final text; the separate core-tool proof covers that producer.
        originClass = "untrusted";
        read.mockClear();
        list.mockClear();
        const manager = await fixture.getFreshManager(config);
        await manager.sync({ reason: "session-start" });
        const results = await manager.search("amber notebook", { lexicalOnly: true, minScore: 0 });
        expect(results.find((result) => result.path === "MEMORY.md")?.provenance?.originClass).toBe(
          "untrusted",
        );
        expect(
          await manager.listTriggerCandidates({ activeProjectKeys: ["fixture/project"] }),
        ).toEqual([]);
        expect(
          await manager.listCuratedProjectCandidates({ activeProjectKeys: ["fixture/project"] }),
        ).toEqual([]);
        expect(fixture.provider.embedBatchCalls).toBe(embeddingCalls);
        expect(fixture.provider.providerRuntimeBatchCalls).toHaveLength(batchCalls);
        expect(list).toHaveBeenCalledOnce();
        expect(read).toHaveBeenCalledTimes(1);
        const db = memoryIndexFixtureWriter(manager);
        expect(db.prepare(query).all()).toEqual(before);
        expect(
          db
            .prepare(
              "SELECT session_kind, observed_at, supersedes_key FROM memory_index_chunk_provenance WHERE chunk_id IN (SELECT id FROM memory_index_chunks WHERE path = 'MEMORY.md')",
            )
            .all(),
        ).toEqual(beforeProvenance);

        // A subsequent unchanged scan reads source origins in bulk and writes none.
        await manager.close();
        read.mockClear();
        list.mockClear();
        const unchanged = await fixture.getFreshManager(config);
        await unchanged.sync({ reason: "session-start" });
        expect(list).toHaveBeenCalledOnce();
        expect(read).not.toHaveBeenCalled();
        expect(fixture.provider.embedBatchCalls).toBe(embeddingCalls);
        expect(fixture.provider.providerRuntimeBatchCalls).toHaveLength(batchCalls);
      } finally {
        read.mockRestore();
        list.mockRestore();
      }
    },
  );

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
      fixture.createConfig({ vectorEnabled: entry.vector, minScore: 0 }),
    );
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as { db: DatabaseSync; provider: EmbeddingProvider };
    const db = fields.db;
    const fixtureWriter = memoryIndexFixtureWriter(manager);
    const semantic = entry.query === "semantic needle";
    const embed = vi.spyOn(fields.provider, "embed").mockResolvedValue([1, 0, 0, 0]);
    fixtureWriter
      .prepare(
        `UPDATE memory_index_chunk_provenance
       SET origin_class = 'owner', session_kind = 'interactive', observed_at = 1234,
           supersedes_key = '  tea-preference  '`,
      )
      .run();
    const updateProvenance = fixtureWriter.prepare(
      `UPDATE memory_index_chunk_provenance SET origin_class = ?, session_kind = ?
       WHERE chunk_id IN (SELECT id FROM memory_index_chunks WHERE path = ?)`,
    );
    updateProvenance.run("untrusted", "unknown", paths[1]!);
    fixtureWriter.exec("PRAGMA ignore_check_constraints = ON");
    updateProvenance.run("invalid", "interactive", paths[2]!);
    updateProvenance.run("owner", "invalid", paths[3]!);
    fixtureWriter.exec("PRAGMA ignore_check_constraints = OFF");
    fixtureWriter
      .prepare(
        `DELETE FROM memory_index_chunk_provenance
       WHERE chunk_id IN (SELECT id FROM memory_index_chunks WHERE path = ?)`,
      )
      .run(paths[4]!);
    fixtureWriter
      .prepare(
        `INSERT OR REPLACE INTO memory_index_chunk_recall_metadata (chunk_id, importance, triggers, project_key)
       SELECT id, 9, ' when flying ', ' github.com/openclaw/openclaw '
       FROM memory_index_chunks WHERE path = ?`,
      )
      .run(paths[0]!);

    const prepare = db.prepare.bind(db);
    const queries = vi.spyOn(db, "prepare").mockImplementation(prepare);
    const knn = vi.spyOn(knnSubprocess, "runVectorKnnInSubprocess");
    try {
      const results = await manager.search(entry.query, {
        lexicalOnly: !semantic,
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
    } finally {
      queries.mockRestore();
      knn.mockRestore();
      embed.mockRestore();
    }
  });
});
