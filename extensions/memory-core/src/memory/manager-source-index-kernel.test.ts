import assert from "node:assert/strict";
import { endianness } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import type { MemorySourceIndexReplacement } from "./manager-source-index-kernel.js";

const databases: MemoryIndexDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.release();
  }
});

async function createDatabase(): Promise<MemoryIndexDatabase> {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  const database = new MemoryIndexDatabase(db);
  databases.push(database);
  const schema = ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
  expect(schema.ftsAvailable).toBe(true);
  const vector = await loadSqliteVecExtension({ db });
  expect(vector.ok).toBe(true);
  db.exec(
    "CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3])",
  );
  database.fts.enabled = true;
  database.fts.available = true;
  database.vector.enabled = true;
  database.vector.available = true;
  return database;
}

function replacement(path: string, hash = "original"): MemorySourceIndexReplacement {
  return {
    source: "memory",
    entry: { path, hash, mtimeMs: 100.25, size: 12 },
    model: "test-model",
    now: 100,
    vectorReady: true,
    embeddings: [[1, 0, 0]],
    chunks: [
      {
        startLine: 1,
        endLine: 1,
        text: `${hash} indexed text`,
        hash,
        importance: 7,
        triggers: "indexed",
        projectKey: "project",
        provenance: { originClass: "owner", sessionKind: "interactive", observedAt: 90 },
      },
    ],
  };
}

function write(database: MemoryIndexDatabase, value: MemorySourceIndexReplacement) {
  return runSqliteImmediateTransactionSync(database.db, () => database.sourceIndex.replace(value));
}

function snapshot(db: DatabaseSync) {
  return [
    "memory_index_sources",
    "memory_index_chunks",
    "memory_index_chunk_recall_metadata",
    "memory_index_chunk_provenance",
    "memory_index_chunks_fts",
    "memory_index_paths_fts",
    "memory_index_state",
  ]
    .map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
    .concat([
      db
        .prepare("SELECT id, hex(embedding) AS embedding FROM memory_index_chunks_vec ORDER BY id")
        .all(),
    ]);
}

describe("memory source index native kernel", () => {
  it("rolls back every index representation when the final source upsert fails", async () => {
    const database = await createDatabase();
    const beforeValue = replacement("memory/current.md");
    beforeValue.chunks.push({
      startLine: 3,
      endLine: 4,
      text: "second indexed text",
      hash: "second",
      importance: 4,
      triggers: "second",
      projectKey: "second-project",
      provenance: { originClass: "agent", sessionKind: "interactive", observedAt: 95 },
    });
    beforeValue.embeddings.push([0.25, -0.5, 2]);
    const sibling = replacement("memory/sibling.md");
    const updated: MemorySourceIndexReplacement = {
      ...beforeValue,
      entry: { ...beforeValue.entry, hash: "updated", mtimeMs: 200.5, size: 24 },
      now: 200,
      chunks: beforeValue.chunks.map((chunk, index) => ({
        ...chunk,
        text: `updated indexed text ${index}`,
        hash: `updated-${index}`,
      })),
      embeddings: [
        [0.5, -0.25, 0.75],
        [-1.25, 2, 0.125],
      ],
    };
    const readRows = () =>
      database.db
        .prepare(`
        SELECT chunk.path, chunk.start_line, chunk.end_line, chunk.text, chunk.embedding,
               metadata.importance, metadata.triggers, metadata.project_key,
               provenance.origin_class, provenance.session_kind, provenance.observed_at,
               hex(vector.embedding) AS vector
        FROM memory_index_chunks AS chunk
        JOIN memory_index_chunks_vec AS vector ON vector.id = chunk.id
        JOIN memory_index_chunk_recall_metadata AS metadata ON metadata.chunk_id = chunk.id
        JOIN memory_index_chunk_provenance AS provenance ON provenance.chunk_id = chunk.id
        ORDER BY chunk.path, chunk.start_line
      `)
        .all();
    const expectedRows = (values: MemorySourceIndexReplacement[]) =>
      values.flatMap((value) =>
        value.chunks.map((chunk, index) => {
          const embedding = value.embeddings[index];
          assert.ok(embedding, "each fixture chunk must have an embedding");
          const view = new DataView(new ArrayBuffer(embedding.length * 4));
          embedding.forEach((number, offset) =>
            view.setFloat32(offset * 4, number, endianness() === "LE"),
          );
          return {
            path: value.entry.path,
            start_line: chunk.startLine,
            end_line: chunk.endLine,
            text: chunk.text,
            embedding: JSON.stringify(embedding),
            importance: chunk.importance,
            triggers: chunk.triggers,
            project_key: chunk.projectKey,
            origin_class: chunk.provenance?.originClass,
            session_kind: chunk.provenance?.sessionKind,
            observed_at: chunk.provenance?.observedAt,
            vector: Buffer.from(view.buffer).toString("hex").toUpperCase(),
          };
        }),
      );
    write(database, beforeValue);
    write(database, sibling);
    expect(readRows()).toEqual(expectedRows([beforeValue, sibling]));
    const before = snapshot(database.db);
    database.db.exec(`CREATE TRIGGER fail_source_update
      AFTER UPDATE ON memory_index_sources
      BEGIN SELECT RAISE(FAIL, 'source upsert failed'); END`);
    expect(() => write(database, updated)).toThrow("source upsert failed");
    expect(snapshot(database.db)).toEqual(before);
    database.db.exec("DROP TRIGGER fail_source_update");
    write(database, updated);
    expect(readRows()).toEqual(expectedRows([updated, sibling]));
    expect(
      database.db
        .prepare("SELECT path, hash, mtime, size FROM memory_index_sources ORDER BY path")
        .all(),
    ).toEqual([
      { path: beforeValue.entry.path, hash: "updated", mtime: 200.5, size: 24 },
      { path: sibling.entry.path, hash: "original", mtime: 100.25, size: 12 },
    ]);
  });

  it("conditionally removes all source representations while retaining a sibling", async () => {
    const database = await createDatabase();
    write(database, replacement("memory/current.md"));
    write(database, replacement("memory/sibling.md"));
    const before = snapshot(database.db);
    const remove = (expectedHash: string) =>
      runSqliteImmediateTransactionSync(database.db, () =>
        database.sourceIndex.deleteIfCurrent({
          path: "memory/current.md",
          source: "memory",
          expectedHash,
        }),
      );
    expect(remove("stale")).toBe(false);
    expect(snapshot(database.db)).toEqual(before);
    expect(remove("original")).toBe(true);
    for (const table of [
      "memory_index_sources",
      "memory_index_chunks",
      "memory_index_chunks_fts",
      "memory_index_paths_fts",
    ]) {
      expect(database.db.prepare(`SELECT path FROM ${table}`).all()).toEqual([
        { path: "memory/sibling.md" },
      ]);
    }
    for (const table of [
      "memory_index_chunk_recall_metadata",
      "memory_index_chunk_provenance",
      "memory_index_chunks_vec",
    ]) {
      expect(database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
        count: 1,
      });
    }
  });
});
