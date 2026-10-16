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
        cacheSize: countMemoryEmbeddingCache(database),
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
            ON memory_embedding_cache(updated_at);`,
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
  beforeEach(() => write(() => db().exec("DELETE FROM memory_embedding_cache")));
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
          cacheSize: countMemoryEmbeddingCache(database),
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
          cacheSize: countMemoryEmbeddingCache(database),
          provider: { id, model: identity.model },
          providerKey: identity.providerKey,
          entries: () => [{ hash: "shared", embedding: [1, 2] }],
          now: 1,
        }),
      );
    }
    expect(write(() => pruneMemoryEmbeddingCache(database, 2, 1))).toBe(1);
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
    const retained = write(() => pruneMemoryEmbeddingCache(database, 401, 300));
    expect(retained).toBe(301);
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
});
