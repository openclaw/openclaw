import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createMemoryChunkWriter } from "./manager-chunk-writer.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");
const CHUNK_WRITE_TABLES = [
  "memory_index_chunks",
  "memory_index_chunk_recall_metadata",
  "memory_index_chunk_provenance",
];

function chunkWriteTables(sqls: string[]): string[] {
  return sqls.flatMap((sql) => {
    const table = /^\s*INSERT INTO "?(\w+)"?\s*\(/i.exec(sql)?.[1];
    return table && CHUNK_WRITE_TABLES.includes(table) ? [table] : [];
  });
}

describe("memory chunk publication", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it.each(["none", "batch-wide-test"])(
    "bounds preparations while preserving oversized entry annotations (%s)",
    async (provider) => {
      const memoryPath = path.join(fixture.paths.workspace, "MEMORY.md");
      await fs.writeFile(
        memoryPath,
        [
          "- Oversized alpha entry. <!-- trigger: oversized alpha --> <!-- importance: 8 --> <!-- project: alpha-key -->",
          `  ${"alpha-fragment-body ".repeat(400)}`,
          "- Global neighbor. <!-- trigger: global neighbor -->",
        ].join("\n"),
      );
      const manager = await fixture.getFreshManager(
        fixture.createConfig({ provider, batchEnabled: true, vectorEnabled: false }),
        "cli",
      );
      try {
        const settings = Reflect.get(manager, "settings") as {
          chunking: { tokens: number; overlap: number };
        };
        settings.chunking = { tokens: 64, overlap: 0 };
        const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
        let preparedTables: string[];
        try {
          await manager.sync({ reason: "test", force: true });
          preparedTables = chunkWriteTables(prepare.mock.calls.map(([sql]) => sql));
        } finally {
          prepare.mockRestore();
        }
        const db = Reflect.get(manager, "db") as DatabaseSync;
        const rows = db
          .prepare(
            `SELECT chunk.text, metadata.importance, metadata.triggers,
                    metadata.project_key AS projectKey, provenance.origin_class AS originClass
             FROM memory_index_chunks AS chunk
             LEFT JOIN memory_index_chunk_recall_metadata AS metadata
               ON metadata.chunk_id = chunk.id
             LEFT JOIN memory_index_chunk_provenance AS provenance
               ON provenance.chunk_id = chunk.id
             WHERE chunk.path = 'MEMORY.md' AND chunk.source = 'memory'
             ORDER BY chunk.start_line, chunk.id`,
          )
          .all();
        const fragments = rows.filter((row) => row.triggers === "oversized alpha");
        expect(fragments.length).toBeGreaterThanOrEqual(2);
        expect(
          fragments.every(
            (row) =>
              row.projectKey === "alpha-key" && row.importance === 8 && row.originClass === "agent",
          ),
        ).toBe(true);
        expect(rows.find((row) => row.triggers === "global neighbor")).toMatchObject({
          projectKey: null,
          importance: null,
        });
        const nonemptyFiles = db
          .prepare("SELECT DISTINCT path, source FROM memory_index_chunks")
          .all().length;
        for (const table of CHUNK_WRITE_TABLES) {
          expect(
            preparedTables.filter((prepared) => prepared === table),
            table,
          ).toHaveLength(nonemptyFiles);
        }

        await fs.writeFile(memoryPath, "");
        Reflect.set(manager, "dirty", true);
        const emptyPrepare = vi.spyOn(DatabaseSync.prototype, "prepare");
        try {
          await manager.sync({ reason: "empty-replacement" });
          expect(chunkWriteTables(emptyPrepare.mock.calls.map(([sql]) => sql))).toEqual([]);
        } finally {
          emptyPrepare.mockRestore();
        }
        expect(
          db.prepare("SELECT id FROM memory_index_chunks WHERE path = 'MEMORY.md'").all(),
        ).toEqual([]);
        expect(
          db.prepare("SELECT hash FROM memory_index_sources WHERE path = 'MEMORY.md'").get(),
        ).toBeDefined();
        const results = await manager.search("alpha-fragment-body", { lexicalOnly: true });
        expect(results.map((result) => result.path)).not.toContain("MEMORY.md");
      } finally {
        await manager.close();
      }
    },
  );

  it.each(CHUNK_WRITE_TABLES)(
    "preserves the previous index and retries after %s publication fails",
    async (failedTable) => {
      const manager = await fixture.getFreshManager(
        fixture.createConfig({ cacheEnabled: true }),
        "cli",
      );
      try {
        const db = Reflect.get(manager, "db") as DatabaseSync;
        await manager.sync({ reason: "test" });
        const snapshot = () =>
          [
            "memory_index_sources",
            ...CHUNK_WRITE_TABLES,
            "memory_embedding_cache",
            "memory_index_chunks_fts",
            "memory_index_state",
          ].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
        const before = snapshot();
        expect(before[1]?.some((row) => String(row.text).includes("Alpha memory line."))).toBe(
          true,
        );
        db.exec(`
          CREATE TRIGGER fail_chunk_publication
          AFTER INSERT ON ${failedTable}
          BEGIN
            SELECT RAISE(FAIL, 'forced chunk publication failure');
          END;
        `);
        await fs.writeFile(
          path.join(fixture.paths.memory, "2026-01-12.md"),
          "# Log\nUpdated memory line.",
        );
        Reflect.set(manager, "dirty", true);
        const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
        try {
          await expect(manager.sync({ reason: "test" })).rejects.toThrow(
            "forced chunk publication failure",
          );
          expect(chunkWriteTables(prepare.mock.calls.map(([sql]) => sql))).toEqual(
            CHUNK_WRITE_TABLES.slice(0, CHUNK_WRITE_TABLES.indexOf(failedTable) + 1),
          );
        } finally {
          prepare.mockRestore();
        }
        expect(snapshot()).toEqual(before);

        db.exec("DROP TRIGGER fail_chunk_publication");
        await manager.sync({ reason: "retry" });
        expect(
          db
            .prepare("SELECT text FROM memory_index_chunks WHERE path LIKE ? AND source = ?")
            .all("%2026-01-12.md", "memory"),
        ).toEqual([{ text: "# Log\nUpdated memory line." }]);
        const results = await manager.search("Updated memory line", { lexicalOnly: true });
        expect(results[0]?.snippet).toContain("Updated memory line.");
      } finally {
        await manager.close();
      }
    },
  );

  it("normalizes fractional provenance timestamps before strict SQLite publication", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE memory_index_chunks (
        id TEXT PRIMARY KEY, path TEXT NOT NULL, source TEXT NOT NULL,
        start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, hash TEXT NOT NULL,
        model TEXT NOT NULL, text TEXT NOT NULL, embedding TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE memory_index_chunk_recall_metadata (
        chunk_id TEXT PRIMARY KEY, importance INTEGER, triggers TEXT, project_key TEXT
      ) STRICT;
      CREATE TABLE memory_index_chunk_provenance (
        chunk_id TEXT PRIMARY KEY, origin_class TEXT NOT NULL, session_kind TEXT NOT NULL,
        observed_at INTEGER NOT NULL, supersedes_key TEXT
      ) STRICT;
    `);
    const fractionalTimestamp = 1_789_000_000_000.75;
    try {
      const writeChunk = createMemoryChunkWriter(db, {
        path: "memory/2026-09-09.md",
        source: "memory",
        model: "test",
        now: 1_789_000_000_001,
      });
      expect(() =>
        writeChunk(
          "fractional",
          {
            startLine: 1,
            endLine: 1,
            text: "Fractional provenance timestamp.",
            hash: "hash",
            importance: null,
            triggers: null,
            projectKey: null,
            provenance: {
              originClass: "agent",
              sessionKind: "interactive",
              observedAt: fractionalTimestamp,
            },
          },
          [],
        ),
      ).not.toThrow();
      expect(
        db
          .prepare(
            "SELECT observed_at AS observedAt FROM memory_index_chunk_provenance WHERE chunk_id = ?",
          )
          .get("fractional"),
      ).toEqual({ observedAt: Math.trunc(fractionalTimestamp) });
    } finally {
      db.close();
    }
  });
});
