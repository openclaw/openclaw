// Memory Core tests cover manager embedding cache plugin behavior.
import {
  encodeMemoryEmbedding,
  ensureMemoryIndexSchema,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import {
  collectMemoryCachedEmbeddings,
  loadMemoryEmbeddingCache,
  upsertMemoryEmbeddingCache,
} from "./manager-embedding-cache.js";

describe("memory embedding cache", () => {
  const { DatabaseSync, StatementSync } = requireNodeSqlite();

  function createDb() {
    const db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: true,
      ftsEnabled: false,
      ftsTokenizer: "unicode61",
    });
    return db;
  }

  it("loads cached embeddings for the active provider key", () => {
    const db = createDb();
    const prepare = vi.spyOn(db, "prepare");
    const columns = vi.spyOn(StatementSync.prototype, "columns");
    const largeEmbedding = Array.from({ length: 4096 }, () => 0.1234567890123456);
    try {
      upsertMemoryEmbeddingCache({
        db,
        enabled: true,
        provider: { id: "openai", model: "text-embedding-3-small" },
        providerKey: "provider-key",
        entries: [
          { hash: "a", embedding: [0.1, 0.2] },
          { hash: "b", embedding: [0.3, 0.4] },
          { hash: "a", embedding: largeEmbedding },
        ],
        now: 123,
      });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(columns).not.toHaveBeenCalled();
      expect(
        db
          .prepare(
            "SELECT hash, dims, updated_at, typeof(embedding) AS type, length(embedding) AS bytes FROM memory_embedding_cache ORDER BY hash",
          )
          .all(),
      ).toEqual([
        { hash: "a", dims: 4096, updated_at: 123, type: "blob", bytes: 4096 * 8 },
        { hash: "b", dims: 2, updated_at: 123, type: "blob", bytes: 16 },
      ]);

      const cached = loadMemoryEmbeddingCache({
        db,
        enabled: true,
        providerIdentities: [
          {
            provider: "openai",
            model: "text-embedding-3-small",
            providerKey: "provider-key",
          },
        ],
        hashes: ["a", "b", "a"],
      });

      expect(cached).toEqual(
        new Map([
          ["a", largeEmbedding],
          ["b", [0.3, 0.4]],
        ]),
      );
    } finally {
      prepare.mockRestore();
      columns.mockRestore();
      db.close();
    }
  });

  it.each(["legacy JSON", "legacy import", "binary"] as const)(
    "regenerates inconsistent declared dimensions from %s caches without losing row identity",
    (format) => {
      const db = new DatabaseSync(":memory:");
      const embedding = [1 + Number.EPSILON, 0.1];
      const cases = [
        { hash: "matching", dims: 2, hit: true },
        { hash: "unspecified", dims: null, hit: true },
        { hash: "mismatch", dims: 3, hit: false },
        { hash: "zero", dims: 0, hit: false },
        { hash: "negative", dims: -1, hit: false },
        { hash: "unsafe-integer", dims: 9_007_199_254_740_993n, hit: false },
      ];
      const identity = { provider: "local", model: "fixture", providerKey: "canonical" };
      const alias = { ...identity, providerKey: "alias" };
      const sourceTable = format === "legacy import" ? "embedding_cache" : "memory_embedding_cache";
      try {
        if (format !== "binary") {
          db.exec(`CREATE TABLE ${sourceTable} (
            provider TEXT NOT NULL, model TEXT NOT NULL, provider_key TEXT NOT NULL,
            hash TEXT NOT NULL, embedding TEXT NOT NULL, dims INTEGER, updated_at INTEGER NOT NULL,
            PRIMARY KEY (provider, model, provider_key, hash)
          ) STRICT`);
        } else {
          ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: false });
        }
        if (format === "legacy import") {
          db.exec(`
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE files (
              path TEXT PRIMARY KEY, source TEXT NOT NULL, hash TEXT NOT NULL,
              mtime REAL NOT NULL, size INTEGER NOT NULL
            );
            CREATE TABLE chunks (
              id TEXT PRIMARY KEY, path TEXT NOT NULL, source TEXT NOT NULL,
              start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, hash TEXT NOT NULL,
              model TEXT NOT NULL, text TEXT NOT NULL, embedding TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
          `);
        }
        const insert = db.prepare(`INSERT INTO ${sourceTable}
          (rowid, provider, model, provider_key, hash, embedding, dims, updated_at)
          VALUES (?, 'local', 'fixture', ?, ?, ?, ?, 121)`);
        insert.setReadBigInts(true);
        for (const [index, row] of cases.entries()) {
          const rowid = 9_007_199_254_740_993n + BigInt(index);
          insert.run(
            rowid,
            identity.providerKey,
            row.hash,
            format === "binary" ? encodeMemoryEmbedding(embedding) : JSON.stringify(embedding),
            row.dims,
          );
          insert.run(
            index + 1,
            alias.providerKey,
            row.hash,
            format === "binary" ? encodeMemoryEmbedding([9, 9]) : "[9,9]",
            2,
          );
        }
        const readIdentity = (table = "memory_embedding_cache", includeRowid = true) => {
          const statement = db.prepare(`SELECT ${includeRowid ? "rowid," : ""}
            provider, model, provider_key, hash, dims, updated_at
            FROM ${table} ORDER BY provider, model, provider_key, hash`);
          statement.setReadBigInts(true);
          return statement.all();
        };
        const preservesSourceRowid = format !== "legacy import";
        const originalIdentity = readIdentity(sourceTable, preservesSourceRowid);
        ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: false });
        expect(readIdentity("memory_embedding_cache", preservesSourceRowid)).toEqual(
          originalIdentity,
        );
        const readMigratedRows = db.prepare(
          "SELECT rowid, * FROM memory_embedding_cache ORDER BY rowid",
        );
        readMigratedRows.setReadBigInts(true);
        const migratedRows = readMigratedRows.all();
        expect(
          db.prepare("SELECT DISTINCT typeof(embedding) AS kind FROM memory_embedding_cache").all(),
        ).toEqual([{ kind: "blob" }]);

        const cached = loadMemoryEmbeddingCache({
          db,
          enabled: true,
          providerIdentities: [identity, alias],
          hashes: cases.map((row) => row.hash),
        });
        expect(cached).toEqual(new Map(cases.map((row) => [row.hash, row.hit ? embedding : []])));
        const { missing } = collectMemoryCachedEmbeddings({ chunks: cases, cached });
        expect(missing.map(({ chunk }) => chunk.hash)).toEqual([
          "mismatch",
          "zero",
          "negative",
          "unsafe-integer",
        ]);
        expect(readMigratedRows.all()).toEqual(migratedRows);

        const regenerated = [Math.PI, -0];
        const regeneratedBytes = encodeMemoryEmbedding(regenerated);
        const regeneratedHashes = new Set(missing.map(({ chunk }) => chunk.hash));
        const largestRowid = migratedRows.at(-1)?.rowid;
        if (typeof largestRowid !== "bigint") {
          throw new Error("Expected a native 64-bit cache rowid");
        }
        upsertMemoryEmbeddingCache({
          db,
          enabled: true,
          provider: { id: identity.provider, model: identity.model },
          providerKey: identity.providerKey,
          entries: [
            { hash: "new", embedding: regenerated },
            ...missing.map(({ chunk }) => ({ hash: chunk.hash, embedding: regenerated })),
          ],
          now: 222,
        });
        const updatedRows = readMigratedRows.all();
        const expectedRows: typeof migratedRows = [];
        for (const row of migratedRows) {
          expectedRows.push(
            row.provider_key === identity.providerKey && regeneratedHashes.has(String(row.hash))
              ? { ...row, embedding: regeneratedBytes, dims: 2n, updated_at: 222n }
              : row,
          );
        }
        expect(updatedRows.filter((row) => row.hash !== "new")).toEqual(expectedRows);
        expect(updatedRows.find((row) => row.hash === "new")).toEqual({
          rowid: largestRowid + 1n,
          provider: identity.provider,
          model: identity.model,
          provider_key: identity.providerKey,
          hash: "new",
          embedding: regeneratedBytes,
          dims: 2n,
          updated_at: 222n,
        });
        const refreshed = loadMemoryEmbeddingCache({
          db,
          enabled: true,
          providerIdentities: [identity, alias],
          hashes: [...cases.map((row) => row.hash), "new"],
        });
        expect(refreshed).toEqual(
          new Map([
            ...cases.map((row): [string, number[]] => [
              row.hash,
              row.hit ? embedding : regenerated,
            ]),
            ["new", regenerated],
          ]),
        );
        expect(
          collectMemoryCachedEmbeddings({
            chunks: [...cases, { hash: "new" }],
            cached: refreshed,
          }).missing,
        ).toEqual([]);
      } finally {
        db.close();
      }
    },
  );

  it("reserves space before replacing cached vectors at capacity", () => {
    const db = createDb();
    const provider = { id: "local", model: "fixture" };
    try {
      upsertMemoryEmbeddingCache({
        db,
        enabled: true,
        provider,
        providerKey: "fixture",
        entries: [
          { hash: "a", embedding: [1] },
          { hash: "b", embedding: [2] },
        ],
        now: 1,
      });
      db.exec(`CREATE TEMP TRIGGER reject_cache_overflow BEFORE INSERT ON memory_embedding_cache
        WHEN (SELECT COUNT(*) FROM memory_embedding_cache) >= 2
        BEGIN SELECT RAISE(ABORT, 'cache overflow'); END;`);
      db.exec("BEGIN IMMEDIATE");
      upsertMemoryEmbeddingCache({
        db,
        enabled: true,
        provider,
        providerKey: "fixture",
        maxEntries: 2,
        entries: [
          { hash: "a", embedding: [3] },
          { hash: "a", embedding: [4] },
        ],
        now: 2,
      });
      db.exec("COMMIT");
      expect(
        db.prepare("SELECT hash, embedding FROM memory_embedding_cache ORDER BY hash").all(),
      ).toEqual([
        { hash: "a", embedding: encodeMemoryEmbedding([4]) },
        { hash: "b", embedding: encodeMemoryEmbedding([2]) },
      ]);
    } finally {
      db.close();
    }
  });

  it.each([
    { name: "truncated", embedding: new Uint8Array([1, 2, 3]) },
    { name: "non-finite", embedding: new Uint8Array([0, 0, 0, 0, 0, 0, 240, 127]) },
  ])("regenerates $name cache data while respecting provider alias priority", ({ embedding }) => {
    const db = createDb();
    try {
      upsertMemoryEmbeddingCache({
        db,
        enabled: true,
        provider: { id: "local", model: "hf:owner/default.gguf" },
        providerKey: "provider-key-current",
        entries: [
          { hash: "overlap", embedding: [1, 2] },
          { hash: "empty", embedding: [] },
          { hash: "invalid", embedding: [] },
        ],
      });
      db.prepare("UPDATE memory_embedding_cache SET embedding = ? WHERE hash = ?").run(
        embedding,
        "invalid",
      );
      upsertMemoryEmbeddingCache({
        db,
        enabled: true,
        provider: { id: "local", model: "/cache/default.gguf" },
        providerKey: "provider-key-alias",
        entries: ["alias", "overlap", "empty", "invalid"].map((hash) => ({
          hash,
          embedding: [0.1, 0.2],
        })),
      });
      upsertMemoryEmbeddingCache({
        db,
        enabled: true,
        provider: { id: "local", model: "/other/default.gguf" },
        providerKey: "provider-key-arbitrary",
        entries: [{ hash: "arbitrary", embedding: [0.3, 0.4] }],
      });

      const cached = loadMemoryEmbeddingCache({
        db,
        enabled: true,
        providerIdentities: [
          {
            provider: "local",
            model: "hf:owner/default.gguf",
            providerKey: "provider-key-current",
          },
          {
            provider: "local",
            model: "/cache/default.gguf",
            providerKey: "provider-key-alias",
          },
        ],
        hashes: ["alias", "arbitrary", "overlap", "empty", "invalid", "overlap", ""],
      });

      expect(cached).toEqual(
        new Map([
          ["overlap", [1, 2]],
          ["empty", []],
          ["invalid", []],
          ["alias", [0.1, 0.2]],
        ]),
      );
      const { missing } = collectMemoryCachedEmbeddings({
        chunks: ["overlap", "empty", "invalid", "alias", "arbitrary"].map((hash) => ({ hash })),
        cached,
      });
      expect(missing.map(({ chunk }) => chunk.hash)).toEqual(["empty", "invalid", "arbitrary"]);
    } finally {
      db.close();
    }
  });

  it.each([0, 200, 401])(
    "reads each requested cache row at most once with %i canonical hits",
    (canonicalHits) => {
      const db = createDb();
      try {
        const hashes = Array.from({ length: 401 }, (_, index) => `hash-${index}`);
        const providerIdentities = Array.from({ length: 4 }, (_, index) => ({
          provider: "local",
          model: `model-${index}`,
          providerKey: `provider-key-${index}`,
        }));
        for (const [index, identity] of providerIdentities.entries()) {
          upsertMemoryEmbeddingCache({
            db,
            enabled: true,
            provider: { id: identity.provider, model: identity.model },
            providerKey: identity.providerKey,
            entries: (index === 0 ? hashes.slice(0, canonicalHits) : hashes).map((hash) => ({
              hash,
              embedding: [index + 1],
            })),
          });
        }
        const reads: Array<{ bindings: number; rows: number }> = [];
        const prepare = db.prepare.bind(db);
        vi.spyOn(db, "prepare").mockImplementation((sql) => {
          const statement = prepare(sql);
          const iterate = statement.iterate.bind(statement);
          vi.spyOn(statement, "iterate").mockImplementation(function* (...bindings) {
            const read = { bindings: bindings.length, rows: 0 };
            reads.push(read);
            for (const row of iterate(...bindings)) {
              read.rows += 1;
              yield row;
            }
            return undefined;
          });
          return statement;
        });

        const cached = loadMemoryEmbeddingCache({
          db,
          enabled: true,
          providerIdentities,
          hashes: [...hashes, ...hashes.slice(0, 1), ""],
        });

        expect(cached).toEqual(
          new Map(hashes.map((hash, index) => [hash, [index < canonicalHits ? 1 : 2]])),
        );
        expect(reads.every(({ bindings }) => bindings <= 403)).toBe(true);
        expect(reads.reduce((total, { rows }) => total + rows, 0)).toBe(hashes.length);
        expect(reads.length).toBeLessThanOrEqual(2 + Math.ceil((401 - canonicalHits) / 400));
      } finally {
        db.close();
      }
    },
  );

  it("propagates a native cache read failure without retaining a partial cursor", () => {
    const db = createDb();
    try {
      const identity = { provider: "local", model: "fixture", providerKey: "fixture" };
      upsertMemoryEmbeddingCache({
        db,
        enabled: true,
        provider: { id: identity.provider, model: identity.model },
        providerKey: identity.providerKey,
        entries: [
          { hash: "first", embedding: [1, 2] },
          { hash: "second", embedding: [3, 4] },
        ],
      });
      const failingEmbedding = Buffer.from(encodeMemoryEmbedding([3, 4]));
      db.function("read_embedding", (value) => {
        if (value instanceof Uint8Array && failingEmbedding.equals(value)) {
          throw new Error("cache step failed");
        }
        return value;
      });
      db.exec(`
        ALTER TABLE memory_embedding_cache RENAME TO stored_cache;
        CREATE VIEW memory_embedding_cache AS SELECT
          provider, model, provider_key, hash, dims, read_embedding(embedding) AS embedding
          FROM stored_cache;
      `);
      const load = () =>
        loadMemoryEmbeddingCache({
          db,
          enabled: true,
          providerIdentities: [identity],
          hashes: ["first", "second"],
        });
      expect(load).toThrow("cache step failed");
      db.exec(
        "DROP VIEW memory_embedding_cache; ALTER TABLE stored_cache RENAME TO memory_embedding_cache",
      );
      expect(load()).toEqual(
        new Map([
          ["first", [1, 2]],
          ["second", [3, 4]],
        ]),
      );
    } finally {
      db.close();
    }
  });

  it("reuses cached embeddings on forced reindex instead of scheduling new embeds", () => {
    const cached = new Map<string, number[]>([
      ["alpha", [0.1, 0.2]],
      ["beta", [0.3, 0.4]],
    ]);
    const embedMissing = vi.fn();

    const plan = collectMemoryCachedEmbeddings({
      chunks: [{ hash: "alpha" }, { hash: "beta" }],
      cached,
    });

    if (plan.missing.length > 0) {
      embedMissing(plan.missing);
    }

    expect(plan.embeddings).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(plan.missing).toHaveLength(0);
    expect(embedMissing).not.toHaveBeenCalled();
  });
});
