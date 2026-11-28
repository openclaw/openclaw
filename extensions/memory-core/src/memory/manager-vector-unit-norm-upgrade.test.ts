// Memory Core tests cover the unit-norm vector path through real managers:
// full reindex publication and the one-time migration of an earlier index.
import { DatabaseSync } from "node:sqlite";
import {
  ensureSqliteLibrarySelected,
  loadSqliteVecExtension,
  openNodeSqliteDatabase,
} from "openclaw/plugin-sdk/memory-core-host-engine-knn";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { expect, it } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import { VECTOR_UNIT_NORM_META_KEY } from "./manager-vector-unit-norm.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");
const fixture = createManagerIndexFixture({ getMemorySearchManager, closeAllMemorySearchManagers });
const VECTOR_TABLE = "memory_index_chunks_vec";

async function closeManager(manager: Awaited<ReturnType<typeof fixture.getFreshManager>>) {
  await manager.close();
  await closeAllMemorySearchManagers();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
}

function readFloat32(blob: Uint8Array): Float32Array {
  const vector = new Float32Array(blob.byteLength / 4);
  new Uint8Array(vector.buffer).set(blob);
  return vector;
}

/** Reads (or, with *rewrite*, edits) the published vector index with sqlite-vec loaded. */
async function withVectorDb<T>(dbPath: string, run: (db: DatabaseSync) => T): Promise<T> {
  ensureSqliteLibrarySelected();
  const db = openNodeSqliteDatabase(dbPath, { allowExtension: true });
  try {
    const loaded = await loadSqliteVecExtension({ db });
    expect(loaded.ok, loaded.error).toBe(true);
    return run(db);
  } finally {
    db.close();
  }
}

function readState(db: DatabaseSync) {
  const marker = db
    .prepare("SELECT value FROM memory_index_meta WHERE key = ?")
    .get(VECTOR_UNIT_NORM_META_KEY) as { value?: unknown } | undefined;
  const norms = (
    db.prepare(`SELECT id, embedding FROM ${VECTOR_TABLE}`).all() as {
      id: string;
      embedding: Uint8Array;
    }[]
  ).map((row) => Math.hypot(...readFloat32(row.embedding)));
  return { marker: marker?.value, norms };
}

function expectSameResults(
  actual: { path: string; score: number }[],
  expected: { path: string; score: number }[],
) {
  expect(actual.map((entry) => entry.path)).toEqual(expected.map((entry) => entry.path));
  actual.forEach((entry, index) => expect(entry.score).toBeCloseTo(expected[index]!.score, 6));
}

const searchResults = async (manager: Awaited<ReturnType<typeof fixture.getFreshManager>>) =>
  (await manager.search("alpha beta", { minScore: 0 })).map((entry) => ({
    path: entry.path,
    score: entry.score,
  }));

it("publishes unit vectors with the marker, and migrates an unmarked earlier index once", async () => {
  const cfg = fixture.createConfig({ vectorEnabled: true, minScore: 0 });
  const first = await fixture.getFreshManager(cfg);
  await first.sync({ reason: "test", force: true });
  const dbPath = first.status().dbPath;
  expect(first.status().vector?.index?.state).toBe("complete");
  const published = await searchResults(first);
  expect(published.length).toBeGreaterThan(0);
  await closeManager(first);
  if (!dbPath) {
    throw new Error("fixture database path is missing");
  }

  // A full reindex written by this release: unit vectors and the marker.
  const afterPublish = await withVectorDb(dbPath, readState);
  expect(afterPublish.marker).toBe("1");
  expect(afterPublish.norms.length).toBeGreaterThan(0);
  for (const norm of afterPublish.norms) {
    expect(norm).toBeCloseTo(1, 5);
  }

  // Turn it into an index written by an earlier release: the fixture provider's raw,
  // non-unit vectors (token counts) and no marker.
  await withVectorDb(dbPath, (db) => {
    db.exec("BEGIN");
    const rows = db.prepare(`SELECT id, embedding FROM ${VECTOR_TABLE}`).all() as {
      id: string;
      embedding: Uint8Array;
    }[];
    const remove = db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE id = ?`);
    const insert = db.prepare(`INSERT INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`);
    rows.forEach((row, index) => {
      const scaled = readFloat32(row.embedding).map((value) => value * (2 + index));
      remove.run(row.id);
      insert.run(row.id, Buffer.from(scaled.buffer));
    });
    db.prepare("DELETE FROM memory_index_meta WHERE key = ?").run(VECTOR_UNIT_NORM_META_KEY);
    db.exec("COMMIT");
  });
  const earlier = await withVectorDb(dbPath, readState);
  expect(earlier.marker).toBeUndefined();
  expect(earlier.norms.some((norm) => Math.abs(norm - 1) > 0.5)).toBe(true);

  // Before any sync, search keeps the exact cosine path on the unmarked index.
  const upgraded = await fixture.getFreshManager(cfg);
  expectSameResults(await searchResults(upgraded), published);
  // A normal sync runs the one-time migration.
  const embedded = fixture.provider.embedBatchCalls;
  await upgraded.sync({ reason: "watch" });
  expect(fixture.provider.embedBatchCalls).toBe(embedded);
  const migrated = await withVectorDb(dbPath, readState);
  expect(migrated.marker).toBe("1");
  expect(migrated.norms).toHaveLength(afterPublish.norms.length);
  for (const norm of migrated.norms) {
    expect(norm).toBeCloseTo(1, 5);
  }
  expectSameResults(await searchResults(upgraded), published);
  await closeManager(upgraded);
});
