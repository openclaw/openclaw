import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getEnvironmentData, threadId } from "node:worker_threads";
import {
  openEngineStore,
  withEngineStoreAdmission,
  type EngineConnection,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import {
  encodeMemoryEmbedding,
  isPostgresSqlConnection,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearMemoryEmbeddingCacheIdentities,
  countMemoryEmbeddingCache,
  loadMemoryEmbeddingCache,
  pruneMemoryEmbeddingCache,
  upsertMemoryEmbeddingCache,
} from "./manager-embedding-cache.js";

const configured: unknown = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const identity = { provider: "local", model: "fixture", providerKey: "fixture" };
const provider = { id: identity.provider, model: identity.model };

describe.skipIf(!connection)("PostgreSQL memory embedding cache", () => {
  const dirs = useAutoCleanupTempDirTracker(afterAll);
  let anchor: DatabaseSync;
  let namespace: string;
  let database: EngineConnection;
  function db() {
    if (!isPostgresSqlConnection(database)) {
      throw new Error("Expected PostgreSQL cache fixture");
    }
    return database;
  }
  const write = <T>(operation: () => T) =>
    withEngineStoreAdmission(() => runSqliteImmediateTransactionSync(database, operation));
  const entries = (size: number) =>
    Array.from({ length: size }, (_, index) => ({
      hash: `hash-${String(index).padStart(3, "0")}`,
      embedding: [index, Math.PI],
    }));
  const publish = (rows: ReturnType<typeof entries>, maxEntries?: number, now = 1) =>
    write(() =>
      upsertMemoryEmbeddingCache({
        db: database,
        cacheSize: { size: countMemoryEmbeddingCache(database), exact: true },
        provider,
        providerKey: identity.providerKey,
        entries: () => rows,
        maxEntries,
        now,
      }),
    );
  const read = (hashes: string[]) =>
    withEngineStoreAdmission(() =>
      loadMemoryEmbeddingCache({ db: database, providerIdentities: [identity], hashes }),
    );

  beforeAll(() => {
    expect(threadId, "The suite retains one in-process admission descriptor").toBe(0);
    const { DatabaseSync } = requireNodeSqlite();
    anchor = new DatabaseSync(path.join(dirs.make("pg-memory-cache-"), "anchor.sqlite"));
    database = withEngineStoreAdmission(() =>
      openEngineStore({
        anchor,
        schema: {
          id: "memory_cache",
          version: 1,
          sqlite: "",
          postgres: `CREATE TABLE memory_embedding_cache (
            provider TEXT COLLATE "C" NOT NULL, model TEXT COLLATE "C" NOT NULL,
            provider_key TEXT COLLATE "C" NOT NULL, hash TEXT COLLATE "C" NOT NULL,
            embedding BYTEA NOT NULL, dims BIGINT, updated_at BIGINT NOT NULL,
            PRIMARY KEY (provider, model, provider_key, hash)
          ); CREATE INDEX idx_memory_embedding_cache_updated_at
            ON memory_embedding_cache(updated_at ASC NULLS FIRST);
          CREATE TABLE memory_index_chunks (
            id TEXT PRIMARY KEY, hash TEXT NOT NULL, updated_at BIGINT NOT NULL
          );`,
        },
        input: { connection: connection!, schemaPrefix: "memory_cache_test" },
        openSqlite: () => {
          throw new Error("Unexpected SQLite cache fixture");
        },
        prepareAnchor: () => {},
        inspectSqlite: () => ({ hasExistingData: false, hasEngineAnchor: false }),
      }),
    );
    namespace = withEngineStoreAdmission(() =>
      String(db().prepare("SELECT current_schema() AS name").get()?.name),
    );
  });
  beforeEach(() =>
    write(() => db().exec("DELETE FROM memory_embedding_cache; DELETE FROM memory_index_chunks")),
  );
  afterAll(() => {
    withEngineStoreAdmission(() => {
      try {
        if (database?.isOpen) {
          db().exec(`DROP SCHEMA "${namespace}" CASCADE`);
        }
      } finally {
        database?.close();
        anchor?.close();
      }
    });
  });

  it("upserts 129 canonical vectors within the binding budget and rolls back both batches", () => {
    const rows = entries(129);
    const query = db().query.bind(db());
    const insertBindings: number[] = [];
    const spy = vi.spyOn(db(), "query").mockImplementation((sql, bindings) => {
      if (/^insert into "memory_embedding_cache"/iu.test(sql)) {
        insertBindings.push(bindings?.length ?? 0);
      }
      return query(sql, bindings);
    });
    try {
      publish([...rows, { hash: "hash-000", embedding: [Number.EPSILON, -0] }]);
    } finally {
      spy.mockRestore();
    }
    expect(insertBindings).toEqual([128 * 7, 7]);
    expect(Math.max(...insertBindings)).toBeLessThanOrEqual(65_535);
    const expected = new Map(rows.map(({ hash, embedding }) => [hash, embedding]));
    expected.set("hash-000", [Number.EPSILON, -0]);
    expect(read(rows.map(({ hash }) => hash))).toEqual(expected);
    withEngineStoreAdmission(() => {
      expect(
        db()
          .prepare("SELECT embedding, dims FROM memory_embedding_cache WHERE hash = ?")
          .get("hash-000"),
      ).toEqual({ embedding: encodeMemoryEmbedding([Number.EPSILON, -0]), dims: 2 });
    });
    expect(() =>
      write(() => {
        upsertMemoryEmbeddingCache({
          db: database,
          cacheSize: { size: countMemoryEmbeddingCache(database), exact: true },
          provider,
          providerKey: identity.providerKey,
          entries: () => entries(129).map(({ hash }) => ({ hash, embedding: [-1, -1] })),
        });
        throw new Error("interrupted publication");
      }),
    ).toThrow("interrupted publication");
    expect(read(rows.map(({ hash }) => hash))).toEqual(expected);
  });

  it("evicts only one composite identity when providers share a hash", () => {
    for (const id of ["a", "z"]) {
      write(() =>
        upsertMemoryEmbeddingCache({
          db: database,
          cacheSize: { size: countMemoryEmbeddingCache(database), exact: true },
          provider: { id, model: identity.model },
          providerKey: identity.providerKey,
          entries: () => [{ hash: "shared", embedding: [1, 2] }],
          now: 1,
        }),
      );
    }
    expect(write(() => pruneMemoryEmbeddingCache(database, { size: 2, exact: true }, 1))).toEqual({
      size: 1,
      exact: true,
    });
    withEngineStoreAdmission(() => {
      expect(db().prepare("SELECT provider, hash FROM memory_embedding_cache").all()).toEqual([
        { provider: "z", hash: "shared" },
      ]);
    });
  });

  it("loads a 401-hash request and evicts by the canonical key at equal timestamps", () => {
    const rows = entries(401);
    publish(rows);
    expect(read(rows.map(({ hash }) => hash))).toEqual(
      new Map(rows.map(({ hash, embedding }) => [hash, embedding])),
    );
    const retained = write(() =>
      pruneMemoryEmbeddingCache(database, { size: 401, exact: true }, 300),
    );
    expect(retained).toEqual({ size: 301, exact: true });
    expect(read(rows.map(({ hash }) => hash))).toEqual(
      new Map(rows.slice(100).map(({ hash, embedding }) => [hash, embedding])),
    );
    publish([{ hash: "fresh", embedding: [42, 43] }], 3, 2);
    expect(read([...rows.map(({ hash }) => hash), "fresh"])).toEqual(
      new Map([
        ["hash-399", [399, Math.PI]],
        ["hash-400", [400, Math.PI]],
        ["fresh", [42, 43]],
      ]),
    );
    expect(write(() => clearMemoryEmbeddingCacheIdentities(database, [identity]))).toBe(3);
    expect(withEngineStoreAdmission(() => countMemoryEmbeddingCache(database))).toBe(0);
  });

  it("walks the generated updated_at index for oldest-first eviction", () => {
    write(() =>
      db().exec(`INSERT INTO memory_embedding_cache
          SELECT 'local', 'fixture', 'fixture', 'hash-' || i, '\\x00'::bytea, 2, i
          FROM generate_series(1, 2000) AS i;
        ANALYZE memory_embedding_cache`),
    );
    const query = db().query.bind(db());
    const evictions: Array<Parameters<typeof query>> = [];
    const spy = vi.spyOn(db(), "query").mockImplementation((sql, bindings) => {
      if (/^delete from "memory_embedding_cache"/iu.test(sql)) {
        evictions.push([sql, bindings]);
      }
      return query(sql, bindings);
    });
    try {
      expect(
        write(() => pruneMemoryEmbeddingCache(database, { size: 2000, exact: true }, 1990)),
      ).toEqual({ size: 1990, exact: true });
    } finally {
      spy.mockRestore();
    }
    expect(evictions).toHaveLength(1);
    const [sql, bindings] = evictions[0]!;
    const plan = withEngineStoreAdmission(() =>
      db()
        .query(`EXPLAIN ${sql}`, bindings)
        .rows.map((row) => String(row["QUERY PLAN"]))
        .join("\n"),
    );
    // A full-cache sort would run on every insertion batch once the cache is at its cap.
    expect(plan).toContain("using idx_memory_embedding_cache_updated_at");
    withEngineStoreAdmission(() => {
      expect(
        db().prepare("SELECT min(updated_at)::integer AS oldest FROM memory_embedding_cache").get(),
      ).toEqual({ oldest: 11 });
    });
  });

  function seedEviction(
    cache: Array<[provider: string, providerKey: string, hash: string, updatedAt: number]>,
    chunks: Array<[hash: string, updatedAt: number]>,
  ) {
    for (const [id, providerKey, hash, now] of cache) {
      write(() =>
        upsertMemoryEmbeddingCache({
          db: database,
          cacheSize: { size: 0, exact: false },
          provider: { id, model: "m" },
          providerKey,
          entries: () => [{ hash, embedding: [1, 2] }],
          now,
        }),
      );
    }
    write(() => {
      for (const [hash, updatedAt] of chunks) {
        db()
          .prepare("INSERT INTO memory_index_chunks (id, hash, updated_at) VALUES (?, ?, ?)")
          .run(`chunk-${hash}`, hash, updatedAt);
      }
    });
    return () =>
      withEngineStoreAdmission(() =>
        db()
          .prepare("SELECT hash FROM memory_embedding_cache ORDER BY hash")
          .all()
          .map((row) => row.hash),
      );
  }

  it("evicts preferred unreferenced rows before older live rows by the canonical key", () => {
    // pending-at-fence is not older than the oldest published chunk.
    const remaining = seedEviction(
      [
        ["openai", "k", "live", 1],
        ["openai", "k", "live-session", 1],
        ["openai", "k", "orphan-newer", 50],
        ["openai", "k", "orphan-older", 40],
        ["openai", "other-key", "orphan-other-key", 2],
        ["local", "k", "orphan-other-provider", 3],
        ["openai", "k", "pending-at-fence", 100],
      ],
      [
        ["live", 100],
        ["live-session", 150],
      ],
    );
    const preference = { identities: [{ provider: "openai", model: "m", providerKey: "k" }] };
    expect(
      write(() => pruneMemoryEmbeddingCache(database, { size: 7, exact: true }, 6, preference)),
    ).toEqual({ size: 6, exact: true });
    expect(remaining()).not.toContain("orphan-older");
    expect(
      write(() => pruneMemoryEmbeddingCache(database, { size: 6, exact: true }, 4, preference)),
    ).toEqual({ size: 4, exact: true });
    expect(remaining()).toEqual([
      "live-session",
      "orphan-other-key",
      "orphan-other-provider",
      "pending-at-fence",
    ]);
  });

  it("reserves insertion capacity from preferred rows and falls back to oldest-first", () => {
    const a = { provider: "openai", model: "m", providerKey: "k" };
    const b = { provider: "local", model: "m", providerKey: "k2" };
    const remaining = seedEviction(
      [
        ["openai", "k", "live", 1],
        ["openai", "k", "orphan-a", 5],
        ["local", "k2", "orphan-b", 6],
        ["openai", "k", "pending", 20],
      ],
      [["live", 10]],
    );
    const insert = (hash: string, identities: Array<typeof a>) =>
      write(() =>
        upsertMemoryEmbeddingCache({
          db: database,
          cacheSize: { size: 4, exact: true },
          provider: { id: "openai", model: "m" },
          providerKey: "k",
          entries: () => [{ hash, embedding: [3, 4] }],
          maxEntries: 4,
          unreferencedFirst: { identities },
          now: 30,
        }),
      );
    // Both listed identities are preferred before the live row, oldest first.
    insert("new-1", [a, b]);
    insert("new-2", [a, b]);
    expect(remaining()).toEqual(["live", "new-1", "new-2", "pending"]);
    // Without preferred identities the reservation takes the oldest row.
    insert("new-3", []);
    expect(remaining()).toEqual(["new-1", "new-2", "new-3", "pending"]);
  });
});
