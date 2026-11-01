import {
  encodeMemoryEmbedding,
  ensureMemoryIndexSchema,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { describe, expect, it } from "vitest";
import {
  collectMemoryCachedEmbeddings,
  countMemoryEmbeddingCache,
  loadMemoryEmbeddingCache,
  pruneMemoryEmbeddingCache,
  upsertMemoryEmbeddingCache,
} from "./manager-embedding-cache.js";

describe("memory embedding cache", () => {
  const { DatabaseSync } = requireNodeSqlite();
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
    const { identity: provider = defaultIdentity, cacheSize, ...rest } = options;
    return upsertMemoryEmbeddingCache({
      db,
      cacheSize: {
        size: cacheSize ?? countMemoryEmbeddingCache(db),
        exact: cacheSize === undefined,
      },
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

  it("rejects retired cache stores without modifying their schema or contents", () => {
    using db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE embedding_cache (
      provider TEXT NOT NULL, model TEXT NOT NULL, provider_key TEXT NOT NULL,
      hash TEXT NOT NULL, embedding TEXT NOT NULL, dims INTEGER, updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, model, provider_key, hash)) STRICT;
      INSERT INTO embedding_cache VALUES ('local', 'fixture', 'fixture', 'h', '[1,2]', 2, 121);
      CREATE TABLE meta (key, value);
      CREATE TABLE files (path, source, hash, mtime, size);
      CREATE TABLE chunks (id, path, source, start_line, end_line, hash,
        model, text, embedding, updated_at);`);
    const snapshot = () => ({
      version: db.prepare("PRAGMA schema_version").get(),
      schema: rows(db, "SELECT type, name, sql FROM sqlite_schema ORDER BY name"),
      changes: db.prepare("SELECT total_changes() AS count").get(),
      rows: rows(db, "SELECT rowid, * FROM embedding_cache", true),
    });
    const before = snapshot();
    expect(() => initialize(db)).toThrow(/retired memory index.*2026\.9\.7/iu);
    expect(snapshot()).toEqual(before);
  });

  it("rejects invalid cached dimensions without changing rows and regenerates them in place", () => {
    using db = new DatabaseSync(":memory:");
    initialize(db);
    const dimensions = [2, null, 3, 0, -1, 9_007_199_254_740_993n];
    const hashes = dimensions.map((_, index) => String(index));
    const embedding = [1 + Number.EPSILON, 0.1];
    const insert = db.prepare(`INSERT INTO memory_embedding_cache
      (rowid, provider, model, provider_key, hash, embedding, dims, updated_at)
      VALUES (?, 'local', 'fixture', 'fixture', ?, ?, ?, 121)`);
    insert.setReadBigInts(true);
    for (const [index, dims] of dimensions.entries()) {
      insert.run(
        9_007_199_254_740_993n + BigInt(index),
        hashes[index]!,
        encodeMemoryEmbedding(embedding),
        dims,
      );
    }
    const readRows = () =>
      rows(db, "SELECT rowid, * FROM memory_embedding_cache ORDER BY rowid", true);
    const before = readRows();
    const cached = load(db, hashes);
    expect(cached).toEqual(
      new Map(hashes.map((hash, index) => [hash, index < 2 ? embedding : []])),
    );
    expect(readRows()).toEqual(before);
    const { missing } = collectMemoryCachedEmbeddings({ hashes, cached });
    expect(missing).toEqual([2, 3, 4, 5]);
    const regenerated = [Math.PI, -0];
    write(
      db,
      vectors(
        missing.map((index) => hashes[index]!),
        regenerated,
      ),
      { now: 222 },
    );
    expect(readRows()).toEqual(
      before.map((row, index) =>
        index < 2
          ? row
          : Object.assign({}, row, {
              embedding: encodeMemoryEmbedding(regenerated),
              dims: 2n,
              updated_at: 222n,
            }),
      ),
    );
    expect(load(db, hashes)).toEqual(
      new Map(hashes.map((hash, index) => [hash, index < 2 ? embedding : regenerated])),
    );
  });

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
    write(
      db,
      [
        ["a", [2]],
        ["c", [3]],
        ["a", [4]],
      ],
      { cacheSize, maxEntries, now: 2 },
    );
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
    const largeEmbedding = Array.from({ length: 4096 }, () => 0.1234567890123456);
    publish([...values, ["hash-0", largeEmbedding]]);
    const expected = new Map(values);
    expected.set("hash-0", largeEmbedding);
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
    expect(pruneMemoryEmbeddingCache(db, { size: 103, exact: true }, 2)).toEqual({
      size: 3,
      exact: true,
    });
    expect(read()).toEqual(["100", "101", "102"].map((hash) => ({ hash })));
    db.exec("COMMIT; BEGIN IMMEDIATE");
    expect(pruneMemoryEmbeddingCache(db, { size: 3, exact: true }, 2)).toEqual({
      size: 2,
      exact: true,
    });
    db.exec("COMMIT");
    expect(read()).toEqual(["101", "102"].map((hash) => ({ hash })));
  });

  function seedEviction(
    db: Database,
    cache: Array<[provider: string, providerKey: string, hash: string, updatedAt: number]>,
    chunks: Array<[hash: string, updatedAt: number]>,
  ) {
    const vector = encodeMemoryEmbedding([0.1, 0.2]);
    const insert = db.prepare(
      "INSERT INTO memory_embedding_cache (provider, model, provider_key, hash, embedding, dims, updated_at) VALUES (?, 'm', ?, ?, ?, 2, ?)",
    );
    for (const [provider, providerKey, hash, updatedAt] of cache) {
      insert.run(provider, providerKey, hash, vector, updatedAt);
    }
    const chunk = db.prepare(
      "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, 'a.md', 'memory', 1, 1, ?, 'm', 't', ?, ?)",
    );
    for (const [hash, updatedAt] of chunks) {
      chunk.run(`chunk-${hash}`, hash, vector, updatedAt);
    }
    return () =>
      rows(db, "SELECT hash FROM memory_embedding_cache ORDER BY hash").map((row) => row.hash);
  }

  it("evicts unreferenced rows of the preferred identities older than every published chunk first", () => {
    using db = new DatabaseSync(":memory:");
    initialize(db);
    // Live rows are the oldest, so plain oldest-first eviction would take them first.
    // pending-at-fence is not older than the oldest published chunk: possibly a retry's
    // or another sync's unpublished work.
    const remaining = seedEviction(
      db,
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

    // Seven rows against a cap of six: one eviction, the oldest preferred row.
    expect(pruneMemoryEmbeddingCache(db, { size: 7, exact: true }, 6, preference)).toEqual({
      size: 6,
      exact: true,
    });
    expect(remaining()).not.toContain("orphan-older");
    // Two more evictions: one preferred row remains, then plain oldest-first.
    expect(pruneMemoryEmbeddingCache(db, { size: 6, exact: true }, 4, preference)).toEqual({
      size: 4,
      exact: true,
    });
    expect(remaining()).toEqual([
      "live-session",
      "orphan-other-key",
      "orphan-other-provider",
      "pending-at-fence",
    ]);
  });

  it("reserves insertion capacity from preferred unreferenced rows before the oldest rows", () => {
    using db = new DatabaseSync(":memory:");
    initialize(db);
    const remaining = seedEviction(
      db,
      [
        ["openai", "k", "live", 1],
        ["openai", "k", "orphan", 5],
        ["openai", "k", "pending", 10],
      ],
      [["live", 10]],
    );
    upsertMemoryEmbeddingCache({
      db,
      cacheSize: { size: 3, exact: true },
      provider: { id: "openai", model: "m" },
      providerKey: "k",
      entries: () => [{ hash: "new", embedding: [0.3, 0.4] }],
      maxEntries: 3,
      unreferencedFirst: { identities: [{ provider: "openai", model: "m", providerKey: "k" }] },
      now: 20,
    });
    // Plain oldest-first would take the live row; the one reserved slot comes
    // from the unreferenced row older than the published chunk.
    expect(remaining()).toEqual(["live", "new", "pending"]);
  });

  it("falls back to plain oldest-first order without preferred identities or a published index, and prefers every listed identity", () => {
    const run = (identities: Identity[], published: boolean, maxEntries = 3) => {
      using db = new DatabaseSync(":memory:");
      initialize(db);
      const remaining = seedEviction(
        db,
        [
          ["openai", "k", "live", 1],
          ["openai", "k", "orphan-a", 5],
          ["local", "k2", "orphan-b", 6],
          ["openai", "k", "pending", 20],
        ],
        published ? [["live", 10]] : [],
      );
      pruneMemoryEmbeddingCache(db, { size: 4, exact: true }, maxEntries, { identities });
      return remaining();
    };
    const a = identity("m", "k", "openai");
    const b = identity("m", "k2", "local");
    // One eviction: plain oldest-first takes the live row unless a preferred row exists.
    expect(run([], true)).toEqual(["orphan-a", "orphan-b", "pending"]);
    expect(run([a, b], false)).toEqual(["orphan-a", "orphan-b", "pending"]);
    // Two evictions: both listed identities are preferred before the live row.
    expect(run([a, b], true, 2)).toEqual(["live", "pending"]);
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
    "loads a multi-batch request with %i canonical hits before consulting aliases",
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
      const cached = load(db, [...hashes, ...hashes.slice(0, 1), ""], providerIdentities);

      expect(cached).toEqual(
        new Map(hashes.map((hash, index) => [hash, [index < canonicalHits ? 1 : 2]])),
      );
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
