import path from "node:path";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  openNodeSqliteDatabase,
  readSqliteDatabaseScopedWriteTokenForPath,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { MEMORY_INDEX_WRITE_SCOPE } from "./manager-publication-task.js";
import { bindSqliteWorkerBackend } from "./manager-publication.worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("publishes settled write tokens and fresh facts for scalar autocommits", () => {
  const filename = path.join(tempDirs.make("memory-publication-scalar-"), "index.sqlite");
  const db = openNodeSqliteDatabase(filename);
  const backend = bindSqliteWorkerBackend(
    { kind: "agent" },
    { databasePath: filename, database: db, admit: () => undefined },
  );
  try {
    ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
    db.exec(`INSERT INTO memory_index_sources(path, source, hash, mtime, size)
      VALUES ('sessions/current', 'sessions', 'old', 1, 1)`);
    let before = readSqliteDatabaseScopedWriteTokenForPath(filename, MEMORY_INDEX_WRITE_SCOPE);
    expect(before).toEqual(expect.any(String));
    for (const model of ["initial-model", "replacement-model"]) {
      const metadata = { provider: "test", model, chunkTokens: 400, chunkOverlap: 80 };
      const outcome = backend.execute({ type: "index.writeMetadata", input: metadata });
      const current = readSqliteDatabaseScopedWriteTokenForPath(filename, MEMORY_INDEX_WRITE_SCOPE);
      expect(current).not.toBe(before);
      expect(outcome).toMatchObject({ ok: true, writeToken: current, facts: { meta: metadata } });
      expect(
        db.prepare("SELECT value FROM memory_index_meta WHERE key = ?").get("memory_index_meta_v1"),
      ).toEqual({ value: JSON.stringify(metadata) });
      before = current;
    }
    const outcome = backend.execute({
      type: "source.refresh",
      input: { path: "sessions/current", hash: "new", mtime: 2, size: 2, expectedHash: "old" },
    });
    const current = readSqliteDatabaseScopedWriteTokenForPath(filename, MEMORY_INDEX_WRITE_SCOPE);
    expect(current).not.toBe(before);
    expect(outcome).toMatchObject({ ok: true, value: true, writeToken: current });
    expect(db.prepare("SELECT hash, mtime, size FROM memory_index_sources").get()).toEqual({
      hash: "new",
      mtime: 2,
      size: 2,
    });
  } finally {
    backend.close();
    db.close();
  }
});

it("retains the cache count across writes and reloads after rollback or an unscoped clear", () => {
  const filename = path.join(tempDirs.make("memory-publication-cache-"), "index.sqlite");
  const db = openNodeSqliteDatabase(filename);
  const backend = bindSqliteWorkerBackend(
    { kind: "agent" },
    { databasePath: filename, database: db, admit: () => undefined },
  );
  ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: false });
  db.exec(`CREATE TEMP TRIGGER reject_cache_fixture BEFORE INSERT ON memory_embedding_cache
    WHEN NEW.hash = 'fail' BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END`);
  const sql = observeHostDataSql();
  const counts = () =>
    sql.queries.filter((query) => /select count\(\*\).*memory_embedding_cache/i.test(query)).length;
  const write = (hashes: string[], maxEntries = 2) =>
    backend.execute({
      type: "cache.write.inline",
      input: {
        header: {
          agentId: "main",
          provider: { id: "test", model: "test" },
          providerKey: "test",
          maxEntries,
        },
        entries: hashes.map((hash) => ({ hash, embedding: [1] })),
      },
    });
  const prune = (maxEntries: number) =>
    backend.execute({ type: "cache.prune", input: { maxEntries } });
  const hashes = () => db.prepare("SELECT hash FROM memory_embedding_cache ORDER BY hash").all();
  try {
    expect(write(["a", "b"])).toMatchObject({ ok: true });
    const coldCounts = counts();
    expect(coldCounts).toBeGreaterThan(0);
    expect(prune(2)).toMatchObject({ ok: true, value: false });
    expect(write(["a"])).toMatchObject({ ok: true });
    expect(hashes()).toEqual([{ hash: "a" }, { hash: "b" }]);
    expect(counts()).toBe(coldCounts);

    // One insert succeeds before the second aborts: neither the rows nor count may leak.
    expect(write(["c", "fail"], 4)).toMatchObject({ ok: false, committed: false });
    expect(prune(2)).toMatchObject({ ok: true, value: false });
    expect(hashes()).toEqual([{ hash: "a" }, { hash: "b" }]);
    // Failed writes invalidate receipts even when SQLite rolls back all rows.
    const settledCounts = counts();

    expect(
      backend.execute({
        type: "cache.clear",
        input: { identities: [{ provider: "test", model: "test", providerKey: "test" }] },
      }),
    ).toMatchObject({ ok: true });
    expect(prune(0)).toMatchObject({ ok: true, value: false });
    expect(hashes()).toEqual([]);
    expect(counts()).toBe(settledCounts);

    expect(write(["a", "b"])).toMatchObject({ ok: true });
    // Forget/repair writers are deliberately unscoped and invalidate the retained count.
    db.exec("DELETE FROM memory_embedding_cache");
    expect(prune(0)).toMatchObject({ ok: true, value: false });
    expect(counts()).toBeGreaterThan(settledCounts);
    expect(write(["c"])).toMatchObject({ ok: true });
    expect(prune(0)).toMatchObject({ ok: true, value: true });
    expect(prune(0)).toMatchObject({ ok: true, value: false });
    expect(hashes()).toEqual([]);
  } finally {
    sql.restore();
    backend.close();
    db.close();
  }
});
