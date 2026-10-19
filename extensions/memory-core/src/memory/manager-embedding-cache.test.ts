import {
  encodeMemoryEmbedding,
  ensureMemoryIndexSchema,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  collectMemoryCachedEmbeddings,
  countMemoryEmbeddingCache,
  loadMemoryEmbeddingCache,
  pruneMemoryEmbeddingCache,
  upsertMemoryEmbeddingCache,
} from "./manager-embedding-cache.js";

describe("memory embedding cache", () => {
  const { DatabaseSync, StatementSync } = requireNodeSqlite();
  type Database = InstanceType<typeof DatabaseSync>;
  type Identity = Parameters<typeof loadMemoryEmbeddingCache>[0]["providerIdentities"][number];
  type Vectors = Array<[hash: string, embedding: number[]]>;
  const identity = (model = "fixture", providerKey = "fixture", provider = "local"): Identity => ({
    provider,
    model,
    providerKey,
  });
  const defaultIdentity = identity();
  const vectors = (hashes: string[], embedding: number[]): Vectors =>
    hashes.map((hash) => [hash, embedding]);
  const initialize = (db: Database) =>
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: true,
      ftsEnabled: false,
      ftsTokenizer: "unicode61",
    });

  function write(
    db: Database,
    values: Vectors,
    options: {
      identity?: Identity;
      cacheSize?: number;
      maxEntries?: number;
      now?: number;
    } = {},
  ) {
    const { identity: provider = defaultIdentity, ...rest } = options;
    return upsertMemoryEmbeddingCache({
      db,
      cacheSize: options.cacheSize ?? countMemoryEmbeddingCache(db),
      provider: { id: provider.provider, model: provider.model },
      providerKey: provider.providerKey,
      entries: () => values.map(([hash, embedding]) => ({ hash, embedding })),
      ...rest,
    });
  }

  function load(db: Database, hashes: string[], providerIdentities = [defaultIdentity]) {
    return loadMemoryEmbeddingCache({ db, hashes, providerIdentities });
  }

  function rows(db: Database, sql: string, bigints = false) {
    const statement = db.prepare(sql);
    statement.setReadBigInts(bigints);
    return statement.all();
  }

  it("loads cached embeddings for the active provider key", () => {
    using db = new DatabaseSync(":memory:");
    initialize(db);
    const largeEmbedding = Array.from({ length: 4096 }, () => 0.1234567890123456);
    const active = identity("text-embedding-3-small", "provider-key", "openai");
    write(
      db,
      [
        ["a", [0.1, 0.2]],
        ["b", [0.3, 0.4]],
        ["a", largeEmbedding],
      ],
      { identity: active, now: 123 },
    );
    expect(
      rows(
        db,
        "SELECT hash, dims, updated_at, typeof(embedding) AS type, length(embedding) AS bytes FROM memory_embedding_cache ORDER BY hash",
      ),
    ).toEqual([
      { hash: "a", dims: 4096, updated_at: 123, type: "blob", bytes: 4096 * 8 },
      { hash: "b", dims: 2, updated_at: 123, type: "blob", bytes: 16 },
    ]);

    expect(load(db, ["a", "b", "a"], [active])).toEqual(
      new Map([
        ["a", largeEmbedding],
        ["b", [0.3, 0.4]],
      ]),
    );
  });

  it.each(["legacy JSON", "retired import", "binary"] as const)(
    "handles %s cache storage without losing row identity",
    (format) => {
      using db = new DatabaseSync(":memory:");
      const embedding = [1 + Number.EPSILON, 0.1];
      const cases = [
        { hash: "matching", dims: 2, hit: true },
        { hash: "unspecified", dims: null, hit: true },
        { hash: "mismatch", dims: 3, hit: false },
        { hash: "zero", dims: 0, hit: false },
        { hash: "negative", dims: -1, hit: false },
        { hash: "unsafe-integer", dims: 9_007_199_254_740_993n, hit: false },
      ];
      const canonical = identity("fixture", "canonical");
      const alias = identity("fixture", "alias");
      const sourceTable =
        format === "retired import" ? "embedding_cache" : "memory_embedding_cache";
      if (format !== "binary") {
        db.exec(`CREATE TABLE ${sourceTable} (
            provider TEXT NOT NULL, model TEXT NOT NULL, provider_key TEXT NOT NULL,
            hash TEXT NOT NULL, embedding TEXT NOT NULL, dims INTEGER, updated_at INTEGER NOT NULL,
            PRIMARY KEY (provider, model, provider_key, hash)
          ) STRICT`);
      } else {
        initialize(db);
      }
      if (format === "retired import") {
        // Retirement admission identifies the old tables by their exact column names.
        db.exec(`
          CREATE TABLE meta (key, value);
          CREATE TABLE files (path, source, hash, mtime, size);
          CREATE TABLE chunks (id, path, source, start_line, end_line, hash,
            model, text, embedding, updated_at);
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
          canonical.providerKey,
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
      const readIdentity = (table = "memory_embedding_cache") =>
        rows(
          db,
          `SELECT rowid,
            provider, model, provider_key, hash, dims, updated_at
            FROM ${table} ORDER BY provider, model, provider_key, hash`,
          true,
        );
      if (format === "retired import") {
        const legacyState = () => ({
          schema: db.prepare("PRAGMA schema_version").get(),
          changes: db.prepare("SELECT total_changes() AS count").get(),
          rows: rows(db, "SELECT rowid, * FROM embedding_cache ORDER BY rowid", true),
          tables: rows(db, "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name"),
        });
        const original = legacyState();
        expect(() => initialize(db)).toThrow(/retired memory index.*2026\.9\.7/iu);
        expect(legacyState()).toEqual(original);
        return;
      }
      const originalIdentity = readIdentity(sourceTable);
      initialize(db);
      expect(readIdentity()).toEqual(originalIdentity);
      const readMigratedRows = () =>
        rows(db, "SELECT rowid, * FROM memory_embedding_cache ORDER BY rowid", true);
      const migratedRows = readMigratedRows();
      expect(
        rows(db, "SELECT DISTINCT typeof(embedding) AS kind FROM memory_embedding_cache"),
      ).toEqual([{ kind: "blob" }]);

      const hashes = cases.map((row) => row.hash);
      const cached = load(db, hashes, [canonical, alias]);
      expect(cached).toEqual(new Map(cases.map((row) => [row.hash, row.hit ? embedding : []])));
      const { missing } = collectMemoryCachedEmbeddings({ hashes, cached });
      const missingHashes = missing.map((index) => cases[index]!.hash);
      expect(missingHashes).toEqual(["mismatch", "zero", "negative", "unsafe-integer"]);
      expect(readMigratedRows()).toEqual(migratedRows);

      const regenerated = [Math.PI, -0];
      const regeneratedBytes = encodeMemoryEmbedding(regenerated);
      const largestRowid = migratedRows.at(-1)?.rowid;
      if (typeof largestRowid !== "bigint") {
        throw new Error("Expected a native 64-bit cache rowid");
      }
      write(db, vectors(["new", ...missingHashes], regenerated), { identity: canonical, now: 222 });
      const updatedRows = readMigratedRows();
      const expectedRows = migratedRows.map((row) => {
        if (
          row.provider_key !== canonical.providerKey ||
          !missingHashes.includes(String(row.hash))
        ) {
          return row;
        }
        return Object.assign({}, row, { embedding: regeneratedBytes, dims: 2n, updated_at: 222n });
      });
      expect(updatedRows.filter((row) => row.hash !== "new")).toEqual(expectedRows);
      expect(updatedRows.find((row) => row.hash === "new")).toEqual({
        rowid: largestRowid + 1n,
        provider: canonical.provider,
        model: canonical.model,
        provider_key: canonical.providerKey,
        hash: "new",
        embedding: regeneratedBytes,
        dims: 2n,
        updated_at: 222n,
      });
      const refreshed = load(db, [...hashes, "new"], [canonical, alias]);
      expect(refreshed).toEqual(
        new Map([
          ...cases.map((row): [string, number[]] => [row.hash, row.hit ? embedding : regenerated]),
          ["new", regenerated],
        ]),
      );
    },
  );

  it.each([
    { name: "below capacity", maxEntries: 7, oldRows: 2, evicted: 0 },
    { name: "exact capacity", maxEntries: 6, oldRows: 2, evicted: 0 },
    { name: "overflow with equal timestamps", maxEntries: 5, oldRows: 2, evicted: 1 },
    { name: "overflow beyond a prune batch", maxEntries: 5, oldRows: 102, evicted: 101 },
  ])("reserves capacity before replacement: $name", ({ maxEntries, oldRows, evicted }) => {
    using db = new DatabaseSync(":memory:");
    initialize(db);
    const readCache = () => rows(db, "SELECT * FROM memory_embedding_cache ORDER BY rowid");
    for (const provider of [
      {
        ...defaultIdentity,
        hashes: ["a", ...Array.from({ length: oldRows - 1 }, (_, index) => `old-${index}`)],
      },
      { ...defaultIdentity, provider: "other", hashes: ["a"] },
      { ...defaultIdentity, model: "other", hashes: ["a"] },
      { ...defaultIdentity, providerKey: "other", hashes: ["a"] },
    ]) {
      write(db, vectors(provider.hashes, [1]), { identity: provider, now: 1 });
    }
    const before = readCache();
    db.exec(`CREATE TEMP TRIGGER reject_cache_overflow BEFORE INSERT ON memory_embedding_cache
        WHEN (SELECT COUNT(*) FROM memory_embedding_cache) >= ${maxEntries}
        BEGIN SELECT RAISE(ABORT, 'cache overflow'); END;`);
    db.exec("BEGIN IMMEDIATE");
    const cacheSize = before.length;
    const reserved = cacheSize + 2 > maxEntries;
    const executions = (["get", "all", "run", "iterate"] as const).map((method) =>
      vi.spyOn(StatementSync.prototype, method),
    );
    let queries: string[];
    try {
      write(
        db,
        [
          ["a", [2]],
          ["c", [3]],
          ["a", [4]],
        ],
        { cacheSize, maxEntries, now: 2 },
      );
      queries = executions.flatMap(({ mock }) =>
        mock.contexts.flatMap((statement) =>
          statement instanceof StatementSync ? [statement.sourceSQL] : [],
        ),
      );
    } finally {
      for (const execution of executions) {
        execution.mockRestore();
      }
    }
    const written = (hash: string, value: number) => ({
      provider: "local",
      model: "fixture",
      provider_key: "fixture",
      hash,
      embedding: encodeMemoryEmbedding([value]),
      dims: 1,
      updated_at: 2,
    });
    // Below capacity the UPSERT replaces in place; at capacity replaced rows are reinserted.
    expect(readCache()).toEqual(
      reserved
        ? [...before.slice(1 + evicted), written("c", 3), written("a", 4)]
        : [
            { ...before[0], embedding: encodeMemoryEmbedding([4]), updated_at: 2 },
            ...before.slice(1),
            written("c", 3),
          ],
    );
    const deletes = queries.filter((query) => /^delete\b/iu.test(query));
    expect({
      deletes: deletes.length,
      inserts: queries.filter((query) => /^insert\b/iu.test(query)).length,
      counts: queries.filter((query) => /^select count\(\*\)/iu.test(query)).length,
    }).toEqual({
      deletes: Number(reserved) + Number(evicted > 0),
      inserts: 1,
      counts: Number(reserved),
    });
    if (evicted) {
      const eviction = deletes.find((query) => /\browid\b/iu.test(query));
      expect(eviction).toBeDefined();
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${eviction}`).all(evicted);
      expect(plan).toContainEqual(
        expect.objectContaining({
          detail: expect.stringContaining(
            "USING COVERING INDEX idx_memory_embedding_cache_updated_at",
          ),
        }),
      );
      expect(plan.some((row) => String(row.detail).includes("TEMP B-TREE"))).toBe(false);
      const opcodes = db
        .prepare(`EXPLAIN ${eviction}`)
        .all(evicted)
        .map((row) => row.opcode);
      expect(opcodes).toContain("DecrJumpZero");
      expect(opcodes).not.toContain("OffsetLimit");
    }
    db.exec("ROLLBACK");
    expect(readCache()).toEqual(before);
  });

  it("keeps the last value across cache batches and rolls back an interrupted publication", () => {
    using db = new DatabaseSync(":memory:");
    initialize(db);
    const values: Vectors = Array.from({ length: 129 }, (_, index) => [
      `hash-${index}`,
      [index, 1],
    ]);
    const hashes = values.map(([hash]) => hash);
    const publish = (batch: Vectors) =>
      runSqliteImmediateTransactionSync(db, () => write(db, batch, { now: 1 }));
    const read = () => load(db, hashes);
    publish([...values, ["hash-0", [999, 1]]]);
    const expected = new Map(values);
    expected.set("hash-0", [999, 1]);
    expect(read()).toEqual(expected);
    db.exec(`CREATE TEMP TRIGGER interrupt_cache_publication
        BEFORE INSERT ON memory_embedding_cache WHEN NEW.hash = 'hash-128'
        BEGIN SELECT RAISE(ABORT, 'interrupted cache publication'); END`);
    expect(() => publish(vectors(hashes, [-1, -1]))).toThrow("interrupted cache publication");
    expect(read()).toEqual(expected);
  });

  it("prunes at most 100 oldest rows per transaction", () => {
    using db = new DatabaseSync(":memory:");
    initialize(db);
    const read = () => rows(db, "SELECT hash FROM memory_embedding_cache ORDER BY rowid");
    const hashes = Array.from({ length: 103 }, (_, index) => String(index));
    write(db, vectors(hashes, [1]), { now: 1 });
    db.exec("BEGIN IMMEDIATE");
    expect(pruneMemoryEmbeddingCache(db, 103, 2)).toBe(3);
    expect(read()).toEqual(["100", "101", "102"].map((hash) => ({ hash })));
    db.exec("COMMIT; BEGIN IMMEDIATE");
    expect(pruneMemoryEmbeddingCache(db, 3, 2)).toBe(2);
    db.exec("COMMIT");
    expect(read()).toEqual(["101", "102"].map((hash) => ({ hash })));
  });

  it.each([
    { name: "truncated", embedding: new Uint8Array([1, 2, 3]) },
    { name: "non-finite", embedding: new Uint8Array([0, 0, 0, 0, 0, 0, 240, 127]) },
  ])("regenerates $name cache data while respecting provider alias priority", ({ embedding }) => {
    using db = new DatabaseSync(":memory:");
    initialize(db);
    const canonical = identity("hf:owner/default.gguf", "provider-key-current");
    const alias = identity("/cache/default.gguf", "provider-key-alias");
    const canonicalValues: Vectors = [
      ["overlap", [1, 2]],
      ["empty", []],
      ["invalid", []],
    ];
    write(db, canonicalValues, { identity: canonical });
    db.prepare("UPDATE memory_embedding_cache SET embedding = ? WHERE hash = ?").run(
      embedding,
      "invalid",
    );
    write(db, vectors(["alias", "overlap", "empty", "invalid"], [0.1, 0.2]), { identity: alias });
    write(db, [["arbitrary", [0.3, 0.4]]], {
      identity: identity("/other/default.gguf", "provider-key-arbitrary"),
    });
    const cached = load(
      db,
      ["alias", "arbitrary", "overlap", "empty", "invalid", "overlap", ""],
      [canonical, alias],
    );

    expect(cached).toEqual(new Map([...canonicalValues, ["alias", [0.1, 0.2]]]));
    const hashes = ["overlap", "empty", "invalid", "alias", "arbitrary"];
    const { missing } = collectMemoryCachedEmbeddings({ hashes, cached });
    expect(missing.map((index) => hashes[index])).toEqual(["empty", "invalid", "arbitrary"]);
  });

  it.each([0, 200, 401])(
    "reads each requested cache row at most once with %i canonical hits",
    (canonicalHits) => {
      using db = new DatabaseSync(":memory:");
      initialize(db);
      const hashes = Array.from({ length: 401 }, (_, index) => `hash-${index}`);
      const providerIdentities = Array.from({ length: 4 }, (_, index) =>
        identity(`model-${index}`, `provider-key-${index}`),
      );
      for (const [index, provider] of providerIdentities.entries()) {
        write(db, vectors(index === 0 ? hashes.slice(0, canonicalHits) : hashes, [index + 1]), {
          identity: provider,
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

      const cached = load(db, [...hashes, ...hashes.slice(0, 1), ""], providerIdentities);

      expect(cached).toEqual(
        new Map(hashes.map((hash, index) => [hash, [index < canonicalHits ? 1 : 2]])),
      );
      expect(reads.every(({ bindings }) => bindings <= 403)).toBe(true);
      expect(reads.reduce((total, read) => total + read.rows, 0)).toBe(hashes.length);
      expect(reads.length).toBeLessThanOrEqual(2 + Math.ceil((401 - canonicalHits) / 400));
    },
  );

  it("propagates a native cache read failure without retaining a partial cursor", () => {
    using db = new DatabaseSync(":memory:");
    initialize(db);
    const values: Vectors = [
      ["first", [1, 2]],
      ["second", [3, 4]],
    ];
    write(db, values);
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
    const read = () => load(db, ["first", "second"]);
    expect(read).toThrow("cache step failed");
    db.exec(
      "DROP VIEW memory_embedding_cache; ALTER TABLE stored_cache RENAME TO memory_embedding_cache",
    );
    expect(read()).toEqual(new Map(values));
  });
});
