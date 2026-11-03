import { encodeMemoryEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  openNodeSqliteDatabase,
  readSqliteDatabaseScopedWriteTokenForPath,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { expect, it } from "vitest";
import {
  createPublication,
  publicationReplacement,
  publicationState as state,
} from "./manager-publication-fixture.test-support.js";
import {
  MEMORY_EMBEDDING_CACHE_WRITE_SCOPE,
  MEMORY_INDEX_WRITE_SCOPE,
} from "./manager-publication-task.js";

const meta = {
  provider: "test",
  model: "test-model",
  providerKey: "legacy",
  chunkTokens: 400,
  chunkOverlap: 80,
};
const upgradedFacts = { meta: { ...meta, providerKey: "canonical" } };
const upgrade = {
  type: "index.upgradeProviderKey",
  input: { meta, providerKey: "canonical" },
} as const;

it("atomically promotes an exact legacy identity while preserving canonical cache rows", () => {
  using fixture = createPublication({ cacheEnabled: true });
  const { filename, db, expectResult, admission } = fixture;
  const rows = () => db.prepare("SELECT rowid, * FROM memory_embedding_cache ORDER BY rowid").all();
  expectResult({ type: "index.writeMetadata", input: meta });
  const insert = db.prepare(`INSERT INTO memory_embedding_cache
      (provider, model, provider_key, hash, embedding, dims, updated_at)
      VALUES (?, ?, ?, ?, ?, 2, ?)`);
  const fixtures = [
    ["test", "test-model", "legacy", "move"],
    ["test", "test-model", "legacy", "shared"],
    ["test", "test-model", "canonical", "shared"],
    ["other-provider", "test-model", "legacy", "move"],
    ["test", "other-model", "legacy", "move"],
    ["test", "test-model", "unrelated", "move"],
  ];
  for (const [index, row] of fixtures.entries()) {
    insert.run(...row, encodeMemoryEmbedding([index + 0.125, -0]), 100 + index);
  }
  const before = rows();
  expectResult(
    {
      ...upgrade,
      input: { ...upgrade.input, meta: { ...meta, chunkTokens: 200 } },
    },
    { ok: true, value: false, facts: { meta } },
  );
  expect(rows()).toEqual(before);

  admission.denied = true;
  expectResult(upgrade, {
    ok: false,
    entered: true,
    committed: false,
    error: { message: "publication authority revoked" },
  });
  expect(rows()).toEqual(before);
  expectResult({ type: "index.facts", input: undefined }, { meta });

  admission.denied = false;
  const scopes = [MEMORY_INDEX_WRITE_SCOPE, MEMORY_EMBEDDING_CACHE_WRITE_SCOPE];
  const tokens = scopes.map((scope) => readSqliteDatabaseScopedWriteTokenForPath(filename, scope));
  expectResult(upgrade, { ok: true, value: true, facts: upgradedFacts });
  for (const [index, scope] of scopes.entries()) {
    expect(readSqliteDatabaseScopedWriteTokenForPath(filename, scope)).not.toBe(tokens[index]);
  }
  expect(rows()).toEqual([{ ...before[0], provider_key: "canonical" }, ...before.slice(2)]);
  expectResult(upgrade, { ok: true, value: false, facts: upgradedFacts });
});

it("promotes legacy metadata when no embedding cache table exists", () => {
  using fixture = createPublication();
  const { db, expectResult } = fixture;
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_embedding_cache'").get(),
  ).toBeUndefined();
  expectResult({ type: "index.writeMetadata", input: meta });
  expectResult(upgrade, { ok: true, value: true, facts: upgradedFacts });
});

it("publishes settled tokens and facts for metadata writes and atomic source refreshes", () => {
  using fixture = createPublication();
  const { filename, db, backend, expectResult } = fixture;
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
  expect(outcome).toMatchObject({
    ok: true,
    value: true,
    writeToken: current,
    facts: { revision: 1 },
  });
  expect(db.prepare("SELECT hash, mtime, size FROM memory_index_sources").get()).toEqual({
    hash: "new",
    mtime: 2,
    size: 2,
  });
  expectResult(
    {
      type: "source.refresh",
      input: { path: "sessions/current", hash: "stale", mtime: 3, size: 3, expectedHash: "old" },
    },
    { ok: true, value: false, facts: { revision: 1 } },
  );
});

it("publishes one revision per source batch and rolls back both rows and revision", () => {
  let filename: string;
  {
    using fixture = createPublication({ ftsEnabled: true });
    ({ filename } = fixture);
    const { db, backend, expectResult, admission } = fixture;
    const replace = (text: string) =>
      backend.execute({
        type: "source.replace.group",
        input: publicationReplacement(text),
      });
    const rows = () =>
      db.prepare("SELECT path, text FROM memory_index_chunks ORDER BY path, start_line").all();
    expect(replace("original")).toMatchObject({ ok: true, facts: { revision: 1 } });
    expect(rows()).toHaveLength(4);
    const before = rows();
    admission.denied = true;
    expect(replace("discarded")).toMatchObject({ ok: false, committed: false });
    expect(rows()).toEqual(before);
    expectResult({ type: "index.facts", input: undefined }, { revision: 1 });
    admission.denied = false;
    expect(replace("replacement")).toMatchObject({ ok: true, facts: { revision: 2 } });
    expect(rows().map((row) => row.text)).toEqual([
      "replacement 1",
      "replacement 2",
      "replacement 1",
      "replacement 2",
    ]);
    expectResult(
      {
        type: "source.delete",
        input: { path: "memory/first.md", source: "memory", expectedHash: "replacement", state },
      },
      { ok: true, value: true, facts: { revision: 3 } },
    );
    expect(rows().map((row) => row.path)).toEqual(["memory/second.md", "memory/second.md"]);
  }
  using reopened = openNodeSqliteDatabase(filename);
  expect(reopened.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get()).toEqual({
    revision: 3,
  });
  expect(reopened.prepare("SELECT COUNT(*) AS count FROM memory_index_chunks").get()).toEqual({
    count: 2,
  });
});

it("retains the cache count across writes and reloads after rollback or an unscoped clear", () => {
  using fixture = createPublication({ cacheEnabled: true });
  const { db, backend, expectResult, writeCache: write } = fixture;
  db.exec(`CREATE TEMP TRIGGER reject_cache_fixture BEFORE INSERT ON memory_embedding_cache
    WHEN NEW.hash = 'fail' BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END`);
  const sql = observeHostDataSql();
  const counts = () =>
    sql.queries.filter((query) => /select count\(\*\).*memory_embedding_cache/i.test(query)).length;
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
    // Replacements may inflate the retained upper bound but must not evict live rows.
    expect(prune(2)).toMatchObject({ ok: true });
    expect(hashes()).toEqual([{ hash: "a" }, { hash: "b" }]);
    expect(prune(2)).toMatchObject({ ok: true, value: false });

    // One insert succeeds before the second aborts: neither the rows nor count may leak.
    expect(write(["c", "fail"], 4)).toMatchObject({ ok: false, committed: false });
    expect(prune(2)).toMatchObject({ ok: true, value: false });
    expect(hashes()).toEqual([{ hash: "a" }, { hash: "b" }]);
    // Failed writes invalidate receipts even when SQLite rolls back all rows.
    const settledCounts = counts();

    expectResult({
      type: "cache.clear",
      input: { identities: [{ provider: "test", model: "test", providerKey: "test" }] },
    });
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
  }
});

it.each(["cold", "invalidated"])(
  "recounts the %s cache once inside each mandatory prune",
  (initial) => {
    using fixture = createPublication({ cacheEnabled: true });
    const { db, backend, writeCache: write } = fixture;
    if (initial === "invalidated") {
      expect(write(["old"])).toMatchObject({ ok: true });
      db.exec("DELETE FROM memory_embedding_cache");
    }
    let executedCounts = 0;
    const sql = observeHostDataSql((query, database) => {
      if (database === undefined && /select count\(\*\).*memory_embedding_cache/i.test(query)) {
        executedCounts += 1;
      }
    });
    const prune = () =>
      backend.execute({ type: "cache.prune", input: { maxEntries: 2, recount: true } });
    try {
      expect(prune()).toMatchObject({ ok: true, value: false });
      expect(executedCounts).toBe(1);
      expect(write(["current"])).toMatchObject({ ok: true });
      expect(prune()).toMatchObject({ ok: true, value: false });
      expect(executedCounts).toBe(2);
      expect(db.prepare("SELECT hash FROM memory_embedding_cache").all()).toEqual([
        { hash: "current" },
      ]);
    } finally {
      sql.restore();
    }
  },
);

it("reuses exact cache counts through capacity writes and bounded prune batches", () => {
  using fixture = createPublication({ cacheEnabled: true });
  const { db, backend, writeCache: write } = fixture;
  let executedCounts = 0;
  const sql = observeHostDataSql((query, database) => {
    // Prepare callbacks carry a database; only native statement executions omit it.
    if (database === undefined && /select count\(\*\).*memory_embedding_cache/i.test(query)) {
      executedCounts += 1;
    }
  });
  const prune = (maxEntries: number) =>
    backend.execute({ type: "cache.prune", input: { maxEntries } });
  try {
    expect(write(["a", "b"], 2)).toMatchObject({ ok: true });
    const admittedCounts = executedCounts;
    expect(admittedCounts).toBe(1);
    expect(write(["c"], 2)).toMatchObject({ ok: true });
    expect(write(["c", "d"], 2)).toMatchObject({ ok: true });
    expect(write(["d", "e"], 2)).toMatchObject({ ok: true });
    expect(executedCounts).toBe(admittedCounts);
    expect(db.prepare("SELECT hash FROM memory_embedding_cache ORDER BY hash").all()).toEqual([
      { hash: "d" },
      { hash: "e" },
    ]);

    // An ordinary replacement produces an upper bound, so correct it once before pruning.
    expect(write(["d"], 10)).toMatchObject({ ok: true });
    expect(prune(2)).toMatchObject({ ok: true });
    expect(executedCounts).toBe(admittedCounts + 1);
    expect(prune(2)).toMatchObject({ ok: true, value: false });

    // A sibling write invalidates both the size and its precision through the existing receipt.
    db.exec("DELETE FROM memory_embedding_cache");
    expect(
      write(
        Array.from({ length: 205 }, (_, index) => `row-${index}`),
        205,
      ),
    ).toMatchObject({
      ok: true,
    });
    const reseededCounts = executedCounts;
    expect(reseededCounts).toBe(admittedCounts + 2);
    const recount = () =>
      backend.execute({ type: "cache.prune", input: { maxEntries: 2, recount: true } });
    expect(recount()).toMatchObject({ ok: true, value: true });
    expect(recount()).toMatchObject({ ok: true, value: true });
    expect(recount()).toMatchObject({ ok: true, value: true });
    expect(executedCounts).toBe(reseededCounts);
    expect(recount()).toMatchObject({ ok: true, value: false });
    expect(executedCounts).toBe(reseededCounts + 1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM memory_embedding_cache").get()).toEqual({
      count: 2,
    });
  } finally {
    sql.restore();
  }
});
