import path from "node:path";
import {
  encodeMemoryEmbedding,
  ensureMemoryIndexSchema,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  openNodeSqliteDatabase,
  readSqliteDatabaseScopedWriteTokenForPath,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import {
  MEMORY_EMBEDDING_CACHE_WRITE_SCOPE,
  MEMORY_INDEX_WRITE_SCOPE,
} from "./manager-publication-task.js";
import { memoryPublicationInline } from "./manager-publication-transfer.js";
import { bindSqliteWorkerBackend } from "./manager-publication.worker.js";
import type { MemorySourceIndexReplacement } from "./manager-source-index-kernel.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("atomically promotes an exact legacy identity while preserving canonical cache rows", () => {
  const filename = path.join(tempDirs.make("memory-publication-identity-"), "index.sqlite");
  const db = openNodeSqliteDatabase(filename);
  let denyCommit = false;
  const backend = bindSqliteWorkerBackend(
    { kind: "agent" },
    {
      databasePath: filename,
      database: db,
      admit(stage) {
        if (stage === "commit" && denyCommit) {
          throw new Error("publication authority revoked");
        }
      },
    },
  );
  const meta = {
    provider: "test",
    model: "test-model",
    providerKey: "legacy",
    chunkTokens: 400,
    chunkOverlap: 80,
  };
  const command = {
    type: "index.upgradeProviderKey",
    input: { meta, providerKey: "canonical" },
  } as const;
  const rows = () => db.prepare("SELECT rowid, * FROM memory_embedding_cache ORDER BY rowid").all();
  try {
    ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: false });
    expect(backend.execute({ type: "index.writeMetadata", input: meta })).toMatchObject({
      ok: true,
    });
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
    for (const [index, fixture] of fixtures.entries()) {
      insert.run(...fixture, encodeMemoryEmbedding([index + 0.125, -0]), 100 + index);
    }
    const before = rows();
    expect(
      backend.execute({
        ...command,
        input: { ...command.input, meta: { ...meta, chunkTokens: 200 } },
      }),
    ).toMatchObject({ ok: true, value: false, facts: { meta } });
    expect(rows()).toEqual(before);

    denyCommit = true;
    expect(backend.execute(command)).toMatchObject({
      ok: false,
      entered: true,
      committed: false,
      error: { message: "publication authority revoked" },
    });
    expect(rows()).toEqual(before);
    expect(backend.execute({ type: "index.facts", input: undefined })).toMatchObject({ meta });

    denyCommit = false;
    const scopes = [MEMORY_INDEX_WRITE_SCOPE, MEMORY_EMBEDDING_CACHE_WRITE_SCOPE];
    const tokens = scopes.map((scope) =>
      readSqliteDatabaseScopedWriteTokenForPath(filename, scope),
    );
    const upgraded = { ...meta, providerKey: "canonical" };
    expect(backend.execute(command)).toMatchObject({
      ok: true,
      value: true,
      facts: { meta: upgraded },
    });
    for (const [index, scope] of scopes.entries()) {
      expect(readSqliteDatabaseScopedWriteTokenForPath(filename, scope)).not.toBe(tokens[index]);
    }
    expect(rows()).toEqual([{ ...before[0], provider_key: "canonical" }, ...before.slice(2)]);
    expect(backend.execute(command)).toMatchObject({
      ok: true,
      value: false,
      facts: { meta: upgraded },
    });
  } finally {
    backend.close();
    db.close();
  }
});

it("promotes legacy metadata when no embedding cache table exists", () => {
  const filename = path.join(
    tempDirs.make("memory-publication-identity-no-cache-"),
    "index.sqlite",
  );
  const db = openNodeSqliteDatabase(filename);
  const backend = bindSqliteWorkerBackend(
    { kind: "agent" },
    { databasePath: filename, database: db, admit: () => undefined },
  );
  const meta = {
    provider: "test",
    model: "test-model",
    providerKey: "legacy",
    chunkTokens: 400,
    chunkOverlap: 80,
  };
  try {
    ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_embedding_cache'").get(),
    ).toBeUndefined();
    expect(backend.execute({ type: "index.writeMetadata", input: meta })).toMatchObject({
      ok: true,
    });
    expect(
      backend.execute({
        type: "index.upgradeProviderKey",
        input: { meta, providerKey: "canonical" },
      }),
    ).toMatchObject({
      ok: true,
      value: true,
      facts: { meta: { ...meta, providerKey: "canonical" } },
    });
  } finally {
    backend.close();
    db.close();
  }
});

it("publishes settled tokens and facts for metadata writes and atomic source refreshes", () => {
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
    expect(outcome).toMatchObject({ facts: { revision: 1 } });
    expect(db.prepare("SELECT hash, mtime, size FROM memory_index_sources").get()).toEqual({
      hash: "new",
      mtime: 2,
      size: 2,
    });
    expect(
      backend.execute({
        type: "source.refresh",
        input: { path: "sessions/current", hash: "stale", mtime: 3, size: 3, expectedHash: "old" },
      }),
    ).toMatchObject({ ok: true, value: false, facts: { revision: 1 } });
  } finally {
    backend.close();
    db.close();
  }
});

it("publishes one revision per source batch and rolls back both rows and revision", () => {
  const filename = path.join(tempDirs.make("memory-publication-revision-"), "index.sqlite");
  const db = openNodeSqliteDatabase(filename);
  let denyCommit = false;
  const backend = bindSqliteWorkerBackend(
    { kind: "agent" },
    {
      databasePath: filename,
      database: db,
      admit(stage) {
        if (stage === "commit" && denyCommit) {
          throw new Error("publication authority revoked");
        }
      },
    },
  );
  const state = {
    vector: { enabled: false, available: false },
    fts: { enabled: true, available: true },
    hasVectorTable: false,
  };
  const source = (name: string, text: string) => {
    const replacement: MemorySourceIndexReplacement = {
      source: "memory",
      entry: { path: `memory/${name}.md`, hash: text, mtimeMs: 1, size: text.length },
      model: "fts-only",
      now: 1,
      vectorReady: false,
      embeddings: [[], []],
      chunks: [1, 2].map((line) => ({
        startLine: line,
        endLine: line,
        hash: `${text}-${line}`,
        text: `${text} ${line}`,
        importance: null,
        triggers: null,
        projectKey: null,
      })),
    };
    return memoryPublicationInline(replacement)!;
  };
  const replace = (text: string) =>
    backend.execute({
      type: "source.replace.group",
      input: { sources: [source("first", text), source("second", text)], state },
    });
  const rows = () =>
    db.prepare("SELECT path, text FROM memory_index_chunks ORDER BY path, start_line").all();
  try {
    ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
    expect(replace("original")).toMatchObject({ ok: true, facts: { revision: 1 } });
    expect(rows()).toHaveLength(4);
    const before = rows();
    denyCommit = true;
    expect(replace("discarded")).toMatchObject({ ok: false, committed: false });
    expect(rows()).toEqual(before);
    expect(backend.execute({ type: "index.facts", input: undefined })).toMatchObject({
      revision: 1,
    });
    denyCommit = false;
    expect(replace("replacement")).toMatchObject({ ok: true, facts: { revision: 2 } });
    expect(rows().map((row) => row.text)).toEqual([
      "replacement 1",
      "replacement 2",
      "replacement 1",
      "replacement 2",
    ]);
    expect(
      backend.execute({
        type: "source.delete",
        input: { path: "memory/first.md", source: "memory", expectedHash: "replacement", state },
      }),
    ).toMatchObject({ ok: true, value: true, facts: { revision: 3 } });
    expect(rows().map((row) => row.path)).toEqual(["memory/second.md", "memory/second.md"]);
  } finally {
    backend.close();
    db.close();
  }
  const reopened = openNodeSqliteDatabase(filename);
  try {
    expect(reopened.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get()).toEqual({
      revision: 3,
    });
    expect(reopened.prepare("SELECT COUNT(*) AS count FROM memory_index_chunks").get()).toEqual({
      count: 2,
    });
  } finally {
    reopened.close();
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
  const write = (hashes: string[], maxEntries = 10) =>
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
