// Memory Core tests cover the unit-norm vector path through real managers:
// full reindex publication and the one-time migration of an earlier index.
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
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
import {
  readMemoryVectorsUnitNorm,
  VECTOR_UNIT_NORM_META_KEY,
} from "./manager-vector-unit-norm.js";

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
  expect(await withVectorDb(dbPath, (db) => readMemoryVectorsUnitNorm(db))).toBe(true);
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
  expect(await withVectorDb(dbPath, (db) => readMemoryVectorsUnitNorm(db))).toBe(true);
  expect(migrated.norms).toHaveLength(afterPublish.norms.length);
  for (const norm of migrated.norms) {
    expect(norm).toBeCloseTo(1, 5);
  }
  expectSameResults(await searchResults(upgraded), published);

  // The rebuilt table keeps serving the same connection: incremental writes and search.
  await fs.writeFile(path.join(fixture.paths.memory, "2026-01-13.md"), "# Log\nBeta beta note.");
  // What the file watcher does on a change.
  (upgraded as unknown as { markMemoryWatchDirty: () => void }).markMemoryWatchDirty();
  await upgraded.sync({ reason: "watch" });
  const afterWrite = await withVectorDb(dbPath, readState);
  expect(await withVectorDb(dbPath, (db) => readMemoryVectorsUnitNorm(db))).toBe(true);
  expect(afterWrite.norms.length).toBeGreaterThan(migrated.norms.length);
  for (const norm of afterWrite.norms) {
    expect(norm).toBeCloseTo(1, 5);
  }
  const withNote = await searchResults(upgraded);
  expect(withNote.map((entry) => entry.path)).toContain("memory/2026-01-13.md");
  expect(upgraded.status().vector?.index?.state).toBe("complete");
  await closeManager(upgraded);

  // And after reopening: no second migration, same results.
  const reopened = await fixture.getFreshManager(cfg);
  await reopened.sync({ reason: "watch" });
  expectSameResults(await searchResults(reopened), withNote);
  expect(reopened.status().vector?.index?.state).toBe("complete");

  // Search really uses the unit-norm path: it scores from vec0's L2 distance, so a
  // vector scaled behind its back (marker still current) changes the score; the
  // exact cosine path would not notice.
  const scale = (factor: number) =>
    withVectorDb(dbPath, (db) => {
      const row = db
        .prepare(`SELECT id, embedding FROM ${VECTOR_TABLE} ORDER BY id LIMIT 1`)
        .get() as { id: string; embedding: Uint8Array };
      db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE id = ?`).run(row.id);
      db.prepare(`INSERT INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`).run(
        row.id,
        Buffer.from(readFloat32(row.embedding).map((value) => value * factor).buffer),
      );
    });
  await scale(3);
  const scaledFast = await searchResults(reopened);
  expect(
    scaledFast.some(
      (entry, index) => Math.abs(entry.score - (withNote[index]?.score ?? Number.NaN)) > 1e-6,
    ) || scaledFast.length !== withNote.length,
  ).toBe(true);
  // A writer that does not normalize advances the revision without carrying the
  // marker: search falls back to the exact path at once.
  await withVectorDb(dbPath, (db) =>
    db.exec("UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1"),
  );
  expect((await withVectorDb(dbPath, readState)).marker).toBeDefined();
  expectSameResults(await searchResults(reopened), withNote);
  await closeManager(reopened);

  // The next manager verifies the vectors again and restores the fast path.
  const verified = await fixture.getFreshManager(cfg);
  await verified.sync({ reason: "watch" });
  const reverified = await withVectorDb(dbPath, readState);
  for (const norm of reverified.norms) {
    expect(norm).toBeCloseTo(1, 5);
  }
  expect(await withVectorDb(dbPath, (db) => readMemoryVectorsUnitNorm(db))).toBe(true);
  expectSameResults(await searchResults(verified), withNote);
  await closeManager(verified);
});
