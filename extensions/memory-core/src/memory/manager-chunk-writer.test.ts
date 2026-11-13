import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  createManagerIndexFixture,
  memoryIndexFixtureWriter,
} from "./manager-index.test-support.js";

const memoryIndex = await import("./index.js");
const CHUNK_WRITE_TABLES = ["chunks", "chunk_recall_metadata", "chunk_provenance"].map(
  (table) => `memory_index_${table}`,
);
const PREPARED_WRITE_TABLES = new Set([...CHUNK_WRITE_TABLES, "memory_index_chunks_fts"]);
const query = (db: DatabaseSync, sql: string) => db.prepare(sql).all();

async function withoutCallerWrites(action: () => Promise<void>) {
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  try {
    await action();
    const writes = prepare.mock.calls.filter(([sql]) =>
      PREPARED_WRITE_TABLES.has(/^\s*INSERT INTO "?(\w+)"?\s*\(/i.exec(sql)?.[1] ?? ""),
    );
    expect(writes).toEqual([]);
  } finally {
    prepare.mockRestore();
  }
}

describe("memory chunk publication", () => {
  const fixture = createManagerIndexFixture(memoryIndex);

  it.each(["none", "batch-wide-test"])(
    "publishes oversized entry annotations without caller-thread index writes (%s)",
    async (provider) => {
      const memoryPath = path.join(fixture.paths.workspace, "MEMORY.md");
      await fs.writeFile(
        memoryPath,
        [
          "# Preferences",
          "## Project notes",
          "- Oversized alpha entry. <!-- trigger: oversized alpha --> <!-- importance: 8 --> <!-- project: alpha-key -->",
          `  ${"alpha-fragment-body ".repeat(400)}`,
          "# Scoped beta rule. <!-- project: beta-key --> <!-- trigger: scoped beta --> <!-- importance: 9 -->",
          "- Global neighbor. <!-- trigger: global neighbor -->",
        ].join("\n"),
      );
      const manager = await fixture.getFreshManager(
        fixture.createConfig({ provider, batchEnabled: true, vectorEnabled: false }),
        "cli",
      );
      const settings = Reflect.get(manager, "settings") as {
        chunking: { tokens: number; overlap: number };
      };
      settings.chunking = { tokens: 64, overlap: 0 };
      await withoutCallerWrites(() => manager.sync({ reason: "test", force: true }));
      const db = Reflect.get(manager, "db") as DatabaseSync;
      const read = (sql: string) => query(db, sql);
      const rows = read(`SELECT c.text, m.importance, m.triggers,
          m.project_key AS projectKey, p.origin_class AS originClass
        FROM memory_index_chunks c
        LEFT JOIN memory_index_chunk_recall_metadata m ON m.chunk_id = c.id
        LEFT JOIN memory_index_chunk_provenance p ON p.chunk_id = c.id
        WHERE c.path = 'MEMORY.md' AND c.source = 'memory' ORDER BY c.start_line, c.id`);
      const fragments = rows.filter((row) => row.triggers === "oversized alpha");
      expect(fragments.length).toBeGreaterThanOrEqual(2);
      expect(rows.some((row) => row.text === "# Preferences")).toBe(false);
      expect(fragments[0]?.text).toMatch(
        /^# Preferences\n## Project notes\n- Oversized alpha entry\./,
      );
      for (const row of fragments) {
        expect(row).toMatchObject({ projectKey: "alpha-key", importance: 8, originClass: "agent" });
      }
      for (const [trigger, expected] of [
        ["scoped beta", { text: "# Scoped beta rule.", projectKey: "beta-key", importance: 9 }],
        ["global neighbor", { text: "- Global neighbor.", projectKey: null, importance: null }],
      ] as const) {
        expect(rows.find((row) => row.triggers === trigger)).toMatchObject(expected);
      }
      expect(await manager.listTriggerCandidates({ activeProjectKeys: [] })).toMatchObject([
        { snippet: "- Global neighbor." },
      ]);
      const scoped = await manager.listTriggerCandidates({ activeProjectKeys: ["beta-key"] });
      expect(scoped).toContainEqual(
        expect.objectContaining({ snippet: "# Scoped beta rule.", projectKey: "beta-key" }),
      );
      await fs.writeFile(memoryPath, "");
      Reflect.set(manager, "dirty", true);
      await withoutCallerWrites(() => manager.sync({ reason: "empty-replacement" }));
      expect(read("SELECT id FROM memory_index_chunks WHERE path = 'MEMORY.md'")).toEqual([]);
      expect(
        read("SELECT hash FROM memory_index_sources WHERE path = 'MEMORY.md'")[0],
      ).toBeDefined();
      const results = await manager.search("alpha-fragment-body", { lexicalOnly: true });
      expect(results.map((result) => result.path)).not.toContain("MEMORY.md");
    },
  );

  it.each(CHUNK_WRITE_TABLES)(
    "preserves the previous index and retries after %s publication fails",
    async (failedTable) => {
      const manager = await fixture.getFreshManager(
        fixture.createConfig({ cacheEnabled: true }),
        "cli",
      );
      const db = Reflect.get(manager, "db") as DatabaseSync;
      await manager.sync({ reason: "test" });
      const snapshot = () =>
        [
          "memory_index_sources",
          ...CHUNK_WRITE_TABLES,
          "memory_index_chunks_fts",
          "memory_index_state",
        ].map((table) => query(db, `SELECT * FROM ${table} ORDER BY rowid`));
      const before = snapshot();
      const cacheSnapshot = () => query(db, "SELECT * FROM memory_embedding_cache ORDER BY rowid");
      const cacheBefore = cacheSnapshot();
      expect(before[1]?.some((row) => String(row.text).includes("Alpha memory line."))).toBe(true);
      memoryIndexFixtureWriter(manager).exec(`CREATE TRIGGER fail_chunk_publication
        AFTER INSERT ON ${failedTable}
        BEGIN SELECT RAISE(FAIL, 'forced chunk publication failure'); END;`);
      const updatedText = "# Log\nUpdated memory line.";
      await fs.writeFile(path.join(fixture.paths.memory, "2026-01-12.md"), updatedText);
      Reflect.set(manager, "dirty", true);
      await withoutCallerWrites(async () => {
        await expect(manager.sync({ reason: "test" })).rejects.toThrow(
          "forced chunk publication failure",
        );
      });
      expect(snapshot()).toEqual(before);
      // Completed provider work is durable even when index publication rolls back.
      const retainedCache = cacheSnapshot();
      expect(retainedCache).toEqual(expect.arrayContaining(cacheBefore));
      expect(retainedCache).toHaveLength(cacheBefore.length + 1);
      const completedRequests = fixture.provider.embedBatchCalls;

      memoryIndexFixtureWriter(manager).exec("DROP TRIGGER fail_chunk_publication");
      await manager.sync({ reason: "retry" });
      expect(fixture.provider.embedBatchCalls).toBe(completedRequests);
      expect(cacheSnapshot()).toEqual(retainedCache);
      expect(
        db
          .prepare("SELECT text FROM memory_index_chunks WHERE path LIKE ? AND source = ?")
          .all("%2026-01-12.md", "memory"),
      ).toEqual([{ text: updatedText }]);
      const results = await manager.search("Updated memory line", { lexicalOnly: true });
      expect(results[0]?.snippet).toContain("Updated memory line.");
    },
  );
});
