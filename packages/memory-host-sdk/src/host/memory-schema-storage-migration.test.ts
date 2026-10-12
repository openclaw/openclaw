import { spawnSync } from "node:child_process";
import path from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../../../src/infra/node-sqlite.js";
import { trackSqliteStatementExecutions } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { decodeMemoryEmbedding, encodeMemoryEmbedding } from "./embedding-vector.js";
import {
  buildMemoryEmbeddingCacheSchema,
  MEMORY_INDEX_CHUNKS_SCHEMA_SQL,
} from "./memory-schema-base.js";
import { migrateMemoryIndexStorage } from "./memory-schema-storage-migration.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function legacyDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  onTestFinished(() => db.close());
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE memory_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE memory_index_sources (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL, source TEXT NOT NULL,
      hash TEXT NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL, UNIQUE(path, source)
    ) STRICT;
    CREATE TABLE memory_index_chunks (
      id TEXT PRIMARY KEY, path TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, hash TEXT NOT NULL,
      model TEXT NOT NULL, text TEXT NOT NULL, embedding TEXT NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE memory_index_chunk_provenance (
      chunk_id TEXT PRIMARY KEY REFERENCES memory_index_chunks(id) ON DELETE CASCADE,
      origin_class TEXT NOT NULL, session_kind TEXT NOT NULL, observed_at INTEGER NOT NULL,
      supersedes_key TEXT
    ) STRICT;
    CREATE TABLE memory_embedding_cache (
      provider TEXT NOT NULL, model TEXT NOT NULL, provider_key TEXT NOT NULL,
      hash TEXT NOT NULL, embedding TEXT NOT NULL, dims INTEGER, updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, model, provider_key, hash)
    ) STRICT;
    CREATE VIRTUAL TABLE memory_index_chunks_fts USING fts5(
      text, id UNINDEXED, path UNINDEXED, source UNINDEXED, model UNINDEXED,
      start_line UNINDEXED, end_line UNINDEXED
    );
    INSERT INTO memory_index_sources VALUES(1, 'memory/a.md', 'memory', 'h', 123.5, 32);
    INSERT INTO memory_index_chunks(rowid, id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES(7, 'logical-id', 'memory/a.md', 'memory', 1, 2, 'h', 'model', 'saffronquasar', '[1.0000000000000002,0.1]', 123);
    INSERT INTO memory_index_chunk_provenance VALUES('logical-id', 'owner', 'interactive', 122, 'prior-id');
    INSERT INTO memory_embedding_cache(rowid, provider, model, provider_key, hash, embedding, dims, updated_at)
      VALUES(23, 'provider', 'model', 'provider-key', 'h', '[1.0000000000000002,0.1]', 2, 121);
    INSERT INTO memory_index_chunks_fts(rowid, text, id, path, source, model, start_line, end_line)
      VALUES(99, 'saffronquasar', 'logical-id', 'memory/a.md', 'memory', 'model', 1, 2);
  `);
  return db;
}

function snapshot(db: DatabaseSync) {
  return {
    schema: db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
      .all(),
    chunks: db.prepare("SELECT rowid AS rowid, * FROM memory_index_chunks").all(),
    cache: db.prepare("SELECT rowid AS rowid, * FROM memory_embedding_cache").all(),
    sources: db.prepare("SELECT * FROM memory_index_sources").all(),
    meta: db.prepare("SELECT * FROM memory_index_meta").all(),
    provenance: db.prepare("SELECT * FROM memory_index_chunk_provenance").all(),
    fts: db.prepare("SELECT rowid, * FROM memory_index_chunks_fts").all(),
    foreignKeys: db.prepare("PRAGMA foreign_keys").get(),
  };
}

function binaryDatabase(
  location = ":memory:",
  cacheTable = "memory_embedding_cache",
  tracked = true,
): DatabaseSync {
  const db = tracked ? openNodeSqliteDatabase(location) : new DatabaseSync(location);
  onTestFinished(() => db.close());
  db.exec(MEMORY_INDEX_CHUNKS_SCHEMA_SQL + buildMemoryEmbeddingCacheSchema(cacheTable));
  db.prepare(
    `INSERT INTO memory_index_chunks
       (chunk_rowid, id, path, start_line, end_line, hash, model, text, embedding, updated_at)
       VALUES (7, 'chunk', 'memory/a.md', 1, 2, 'h', 'model', 'retained text', ?, 123)`,
  ).run(encodeMemoryEmbedding([1, 2]));
  db.prepare(
    `INSERT INTO ${cacheTable}
       (provider, model, provider_key, hash, embedding, dims, updated_at)
       VALUES ('provider', 'model', 'key', 'h', ?, 2, 121)`,
  ).run(encodeMemoryEmbedding([1, 2]));
  return db;
}

function countStorageCatalogReads(db: DatabaseSync) {
  return trackSqliteStatementExecutions(db, ["catalog"], (sql) =>
    /^\s*SELECT\b[\s\S]*?\bFROM main\.sqlite_schema\s+WHERE type = 'table'\s+AND name NOT LIKE 'sqlite_%'/i.test(
      sql,
    )
      ? "catalog"
      : null,
  );
}

describe("memory storage migration", () => {
  it.each([
    { label: "tracked transaction", tracked: true, transaction: true, reads: 1 },
    { label: "standalone", tracked: true, transaction: false, reads: 2 },
    { label: "untracked transaction", tracked: false, transaction: true, reads: 2 },
    {
      label: "custom cache transaction",
      tracked: true,
      transaction: true,
      reads: 1,
      cacheTable: "custom_cache",
    },
  ])("validates both storage tables with bounded catalog reads in $label", (testCase) => {
    const cacheTable = testCase.cacheTable ?? "memory_embedding_cache";
    const db = binaryDatabase(":memory:", cacheTable, testCase.tracked);
    if (testCase.transaction) {
      db.exec("BEGIN IMMEDIATE");
    }
    const reads = countStorageCatalogReads(db);
    try {
      migrateMemoryIndexStorage(db, { embeddingCacheTable: cacheTable });
      expect(reads.counts.catalog).toBe(testCase.reads);
      expect(db.prepare("SELECT chunk_rowid, text FROM memory_index_chunks").get()).toEqual({
        chunk_rowid: 7,
        text: "retained text",
      });
      expect(db.prepare(`SELECT dims, updated_at FROM ${cacheTable}`).get()).toEqual({
        dims: 2,
        updated_at: 121,
      });
      expect(db.prepare("SELECT total_changes() AS changes").get()).toEqual({ changes: 2 });
    } finally {
      reads.restore();
    }
  });

  it("rereads storage contracts after local schema changes and rollback", () => {
    const db = binaryDatabase();
    db.exec("BEGIN IMMEDIATE");
    migrateMemoryIndexStorage(db);
    db.exec("CREATE UNIQUE INDEX local_cache_dims ON memory_embedding_cache(dims)");
    expect(() => migrateMemoryIndexStorage(db)).toThrow(/unexpected unique index local_cache_dims/);
    db.exec("ROLLBACK; BEGIN IMMEDIATE");
    expect(() => migrateMemoryIndexStorage(db)).not.toThrow();
    db.exec("ROLLBACK");
  });

  it("rereads storage contracts after a foreign schema commit", () => {
    const location = path.join(tempDirs.make("memory-storage-catalog-"), "memory.sqlite");
    const db = binaryDatabase(location);
    db.exec("BEGIN IMMEDIATE");
    migrateMemoryIndexStorage(db);
    db.exec("COMMIT");
    const foreign = new DatabaseSync(location);
    try {
      foreign.exec("CREATE UNIQUE INDEX foreign_cache_dims ON memory_embedding_cache(dims)");
    } finally {
      foreign.close();
    }
    db.exec("BEGIN IMMEDIATE");
    expect(() => migrateMemoryIndexStorage(db)).toThrow(
      /unexpected unique index foreign_cache_dims/,
    );
    db.exec("ROLLBACK");
  });

  it.skipIf(typeof DatabaseSync.prototype.setAuthorizer !== "function")(
    "keeps both catalog reads under a changing authorizer",
    () => {
      const db = binaryDatabase();
      db.exec("BEGIN IMMEDIATE");
      let allow = true;
      db.setAuthorizer((action, table, column) =>
        !allow &&
        action === constants.SQLITE_READ &&
        (table === "sqlite_master" || table === "sqlite_schema") &&
        column === "sql"
          ? constants.SQLITE_DENY
          : constants.SQLITE_OK,
      );
      const reads = countStorageCatalogReads(db);
      try {
        migrateMemoryIndexStorage(db);
        expect(reads.counts.catalog).toBe(2);
        allow = false;
        expect(() => migrateMemoryIndexStorage(db)).toThrow(/prohibited|not authorized/i);
        db.setAuthorizer(null);
        reads.counts.catalog = 0;
        migrateMemoryIndexStorage(db);
        expect(reads.counts.catalog).toBe(1);
      } finally {
        db.setAuthorizer(null);
        reads.restore();
      }
    },
  );

  it("skips oversized and invalid cache rows visibly across three batches and reruns without writes", () => {
    const db = legacyDatabase();
    db.exec("DELETE FROM memory_embedding_cache");
    const insert = db.prepare(`INSERT INTO memory_embedding_cache
      (rowid, provider, model, provider_key, hash, embedding, dims, updated_at)
      VALUES (?, 'provider', 'model', 'key', ?, '[1,2]', 2, 123)`);
    insert.setReadBigInts(true);
    for (let index = 0; index < 257; index++) {
      insert.run(9007199254740993n + BigInt(index), String(index));
    }
    db.exec(`INSERT INTO memory_embedding_cache
      (rowid, provider, model, provider_key, hash, embedding, dims, updated_at) VALUES
      (-9223372036854775808, 'p', 'm', 'k', 'oversized', '[1]' || replace(hex(zeroblob(524288)), '0', ' '), 1, 1),
      (-1, 'p', 'm', 'k', 'malformed', '[1,null]', 2, 1),
      (9223372036854775807, 'p', 'm', 'k', 'invalid-json', 'invalid', 1, 1)`);
    const warnings: string[] = [];
    migrateMemoryIndexStorage(db, { onWarning: (warning) => warnings.push(warning) });
    expect(warnings).toEqual([expect.stringContaining("Skipped 3 memory_embedding_cache rows")]);
    expect(warnings[0]).toContain("-9223372036854775808, -1, 9223372036854775807");
    const rows = db
      .prepare(`SELECT CAST(rowid AS TEXT) AS id, embedding, dims, updated_at
      FROM memory_embedding_cache ORDER BY rowid`)
      .all();
    expect(rows).toHaveLength(257);
    for (const [index, row] of rows.entries()) {
      expect(row).toEqual({
        id: String(9007199254740993n + BigInt(index)),
        embedding: encodeMemoryEmbedding([1, 2]),
        dims: 2,
        updated_at: 123,
      });
    }
    const changes = db.prepare("SELECT total_changes() AS count").get();
    warnings.length = 0;
    migrateMemoryIndexStorage(db, { onWarning: (warning) => warnings.push(warning) });
    expect(warnings).toEqual([]);
    expect(db.prepare("SELECT total_changes() AS count").get()).toEqual(changes);
  });

  it("converts legacy vectors larger than the child heap while preserving 64-bit storage identities", () => {
    const stateDir = tempDirs.make("memory-storage-heap-");
    const args = [
      "--max-old-space-size=96",
      "--import",
      fileURLToPath(new URL("../../../../scripts/tsx.mjs", import.meta.url)),
      "--input-type=module",
      "--eval",
      `
        import { DatabaseSync } from 'node:sqlite';
        import { migrateMemoryIndexStorage } from ${JSON.stringify(new URL("./memory-schema-storage-migration.ts", import.meta.url).href)};
        const embedding = JSON.stringify(Array.from({ length: 3072 }, (_, index) => (index + 0.1234567890123456) / 9000));
        const results = [];
        for (const kind of ['cache', 'chunks']) {
          const db = new DatabaseSync(':memory:');
          const table = kind === 'cache' ? 'memory_embedding_cache' : 'memory_index_chunks';
          db.exec(kind === 'cache' ?
            \`CREATE TABLE memory_embedding_cache (
              provider TEXT NOT NULL, model TEXT NOT NULL, provider_key TEXT NOT NULL,
              hash TEXT NOT NULL, embedding TEXT NOT NULL, dims INTEGER, updated_at INTEGER NOT NULL,
              PRIMARY KEY (provider, model, provider_key, hash)
            ) STRICT;\` :
            \`CREATE TABLE memory_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
            CREATE TABLE memory_index_sources (
              path TEXT NOT NULL, source TEXT NOT NULL, hash TEXT NOT NULL, UNIQUE (path, source)
            ) STRICT;
            CREATE TABLE memory_index_chunks (
              id TEXT PRIMARY KEY, path TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'memory',
              start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, hash TEXT NOT NULL,
              model TEXT NOT NULL, text TEXT NOT NULL, embedding TEXT NOT NULL, updated_at INTEGER NOT NULL
            ) STRICT;\`);
          const insert = db.prepare(kind === 'cache' ?
            "INSERT INTO memory_embedding_cache(rowid, provider, model, provider_key, hash, embedding, dims, updated_at) VALUES (?, 'provider', 'model', 'key', ?, ?, 3072, 123)" :
            "INSERT INTO memory_index_chunks(rowid, id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, 'memory/a.md', 'memory', 1, 2, 'h', 'model', CAST(X'80' AS TEXT), ?, 123)");
          insert.setReadBigInts(true);
          for (let index = 0; index < 3000; index++) {
            insert.run(9007199254740993n + BigInt(index), String(index), embedding);
          }
          migrateMemoryIndexStorage(db);
          results.push(db.prepare(\`SELECT count(*) AS rows, sum(length(embedding)) AS bytes,
            CAST(min(rowid) AS TEXT) AS first, CAST(max(rowid) AS TEXT) AS last
            FROM \${table}\`).get());
          if (kind === 'chunks') {
            results.push(db.prepare('SELECT DISTINCT hex(text) AS textBytes FROM memory_index_chunks').get());
          }
          db.close();
        }
        console.log(JSON.stringify(results));
      `,
    ];
    const command = process.platform === "win32" ? process.execPath : "/bin/sh";
    const childArgs =
      process.platform === "win32"
        ? args
        : ["-c", 'ulimit -c 0; exec "$@"', "memory-migration", process.execPath, ...args];
    const result = spawnSync(command, childArgs, {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      encoding: "utf8",
    });
    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
    const expected = {
      rows: 3000,
      bytes: 73_728_000,
      first: "9007199254740993",
      last: "9007199254743992",
    };
    expect(JSON.parse(result.stdout)).toEqual([expected, expected, { textBytes: "80" }]);
  });

  it("converts vectors without providers and preserves identity, provenance, cache age, and FTS maintenance", () => {
    const db = legacyDatabase();
    migrateMemoryIndexStorage(db);
    const chunk = db
      .prepare("SELECT chunk_rowid, id, text, embedding, updated_at FROM memory_index_chunks")
      .get()!;
    expect(chunk).toMatchObject({
      chunk_rowid: 7,
      id: "logical-id",
      text: "saffronquasar",
      updated_at: 123,
    });
    expect(chunk.embedding).toBeInstanceOf(Uint8Array);
    if (!(chunk.embedding instanceof Uint8Array)) {
      throw new Error("Expected binary embedding");
    }
    expect(decodeMemoryEmbedding(chunk.embedding)).toEqual([1 + Number.EPSILON, 0.1]);
    expect(db.prepare("SELECT * FROM memory_index_chunk_provenance").get()).toMatchObject({
      chunk_id: "logical-id",
      origin_class: "owner",
      supersedes_key: "prior-id",
    });
    expect(
      db
        .prepare(
          "SELECT rowid, provider, model, provider_key, hash, dims, updated_at FROM memory_embedding_cache",
        )
        .get(),
    ).toEqual({
      rowid: 23,
      provider: "provider",
      model: "model",
      provider_key: "provider-key",
      hash: "h",
      dims: 2,
      updated_at: 121,
    });
    expect(
      db
        .prepare(
          "SELECT rowid, id FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH 'saffronquasar'",
        )
        .get(),
    ).toEqual({ rowid: 7, id: "logical-id" });
    migrateMemoryIndexStorage(db);
    db.exec("VACUUM; UPDATE memory_index_chunks SET text = 'ambercomet' WHERE id = 'logical-id'");
    expect(
      db
        .prepare(
          "SELECT rowid FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH 'ambercomet'",
        )
        .get(),
    ).toEqual({ rowid: 7 });
    expect(
      db
        .prepare(
          "SELECT 1 FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH 'saffronquasar'",
        )
        .get(),
    ).toBeUndefined();
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("retains malformed-vector text and provenance while recording regeneration debt", () => {
    const db = legacyDatabase();
    db.exec(
      "UPDATE memory_index_chunks SET embedding = '[1,null]'; UPDATE memory_embedding_cache SET embedding = 'invalid'",
    );
    migrateMemoryIndexStorage(db);
    expect(
      db.prepare("SELECT text, length(embedding) AS bytes FROM memory_index_chunks").get(),
    ).toEqual({ text: "saffronquasar", bytes: 0 });
    expect(db.prepare("SELECT hash FROM memory_index_sources").get()).toEqual({ hash: "" });
    expect(
      db
        .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_vector_rebuild_v1'")
        .get(),
    ).toEqual({ value: "1" });
    expect(db.prepare("SELECT count(*) AS count FROM memory_index_chunk_provenance").get()).toEqual(
      { count: 1 },
    );
    expect(
      db.prepare("SELECT length(embedding) AS bytes FROM memory_embedding_cache").get(),
    ).toBeUndefined();
  });

  it("rolls physical changes back with its enclosing admitted migration", () => {
    const db = legacyDatabase();
    db.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
    migrateMemoryIndexStorage(db);
    db.exec("ROLLBACK; PRAGMA foreign_keys = ON");
    expect(db.prepare("SELECT embedding FROM memory_index_chunks").get()).toEqual({
      embedding: "[1.0000000000000002,0.1]",
    });
    expect(
      db
        .prepare(
          "SELECT name FROM pragma_table_info('memory_index_chunks') WHERE name = 'chunk_rowid'",
        )
        .get(),
    ).toBeUndefined();
    expect(db.prepare("SELECT rowid FROM memory_index_chunks_fts").get()).toEqual({ rowid: 99 });
    expect(db.prepare("SELECT chunk_id FROM memory_index_chunk_provenance").get()).toEqual({
      chunk_id: "logical-id",
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each([
    [
      "CREATE INDEX operator_chunk_text ON memory_index_chunks(text)",
      /unknown index operator_chunk_text/,
    ],
    [
      "CREATE INDEX operator_cache_age ON memory_embedding_cache(updated_at)",
      /unknown index operator_cache_age/,
    ],
    [
      "CREATE TRIGGER operator_chunk_audit AFTER UPDATE ON memory_index_chunks BEGIN SELECT 1; END",
      /unexpected trigger operator_chunk_audit/,
    ],
    [
      "CREATE VIEW operator_chunk_text AS SELECT text FROM memory_index_chunks",
      /unknown view operator_chunk_text/,
    ],
    [
      "CREATE TABLE operator_chunk_notes (chunk_id TEXT REFERENCES memory_index_chunks(id), note TEXT)",
      /unknown foreign key in operator_chunk_notes/,
    ],
    [
      "ALTER TABLE memory_index_chunks ADD COLUMN operator_note TEXT; UPDATE memory_index_chunks SET operator_note = 'preserve this note'",
      /column definitions differ for memory_index_chunks/,
    ],
    [
      "ALTER TABLE memory_embedding_cache ADD COLUMN operator_note TEXT; UPDATE memory_embedding_cache SET operator_note = 'preserve this cache note'",
      /column definitions differ for memory_embedding_cache/,
    ],
  ] as const)(
    "refuses unknown persisted data or dependencies without touching the original database: %s",
    (addition, refusal) => {
      const db = legacyDatabase();
      db.exec(addition);
      const before = snapshot(db);
      expect(() => migrateMemoryIndexStorage(db)).toThrow(refusal);
      expect(snapshot(db)).toEqual(before);
      expect(
        db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '%storage_migration%'").all(),
      ).toEqual([]);
    },
  );

  it.each([
    {
      schema: MEMORY_INDEX_CHUNKS_SCHEMA_SQL.replace("embedding BLOB", "embedding TEXT"),
      embedding: "[]",
      identityColumn: "chunk_rowid",
    },
    {
      schema: MEMORY_INDEX_CHUNKS_SCHEMA_SQL.replace(
        "chunk_rowid INTEGER PRIMARY KEY,",
        "",
      ).replace("id TEXT NOT NULL UNIQUE", "id TEXT PRIMARY KEY"),
      embedding: new Uint8Array(),
      identityColumn: "rowid",
    },
    {
      schema: MEMORY_INDEX_CHUNKS_SCHEMA_SQL.replace(
        "chunk_rowid INTEGER PRIMARY KEY",
        "chunk_rowid INTEGER PRIMARY KEY DESC",
      ),
      embedding: new Uint8Array(),
      identityColumn: "chunk_rowid",
    },
  ])(
    "refuses mixed identity/format declarations instead of declaring conversion complete",
    ({ schema, embedding, identityColumn }) => {
      const db = legacyDatabase();
      db.exec("PRAGMA foreign_keys = OFF; DROP TABLE memory_index_chunks");
      db.exec(schema);
      db.prepare(`INSERT INTO memory_index_chunks(${identityColumn}, id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES(7, 'logical-id', 'memory/a.md', 'memory', 1, 2, 'h', 'model', 'saffronquasar', ?, 123)`).run(
        embedding,
      );
      db.exec("PRAGMA foreign_keys = ON");
      const before = snapshot(db);
      expect(() => migrateMemoryIndexStorage(db)).toThrow(/partial memory storage|noncanonical/);
      expect(snapshot(db)).toEqual(before);
    },
  );

  it.each([new Uint8Array([1]), new Uint8Array(Buffer.from("000000000000f87f", "hex"))])(
    "refuses malformed preexisting binary cache rows while a chunk conversion is pending",
    (embedding) => {
      const db = legacyDatabase();
      db.exec("DROP TABLE memory_embedding_cache");
      db.exec(buildMemoryEmbeddingCacheSchema("memory_embedding_cache"));
      db.prepare(
        "INSERT INTO memory_embedding_cache VALUES('provider', 'model', 'provider-key', 'h', ?, 2, 121)",
      ).run(embedding);
      const before = snapshot(db);
      expect(() => migrateMemoryIndexStorage(db)).toThrow("invalid binary embeddings");
      expect(snapshot(db)).toEqual(before);
    },
  );

  it("validates an already-binary cache before completing the remaining chunk migration", () => {
    const db = legacyDatabase();
    db.exec("DROP TABLE memory_embedding_cache");
    db.exec(buildMemoryEmbeddingCacheSchema("memory_embedding_cache"));
    db.exec("ALTER TABLE memory_embedding_cache ADD COLUMN retained_note TEXT");
    const embedding = encodeMemoryEmbedding([1 + Number.EPSILON, 0.1]);
    db.prepare(
      "INSERT INTO memory_embedding_cache VALUES('provider', 'model', 'provider-key', 'h', ?, 2, 121, 'current format extension')",
    ).run(embedding);
    migrateMemoryIndexStorage(db);
    expect(db.prepare("SELECT embedding, retained_note FROM memory_embedding_cache").get()).toEqual(
      { embedding, retained_note: "current format extension" },
    );
    expect(
      db.prepare("SELECT chunk_rowid, typeof(embedding) AS kind FROM memory_index_chunks").get(),
    ).toEqual({ chunk_rowid: 7, kind: "blob" });
  });

  it("refuses malformed binary chunks before converting a remaining legacy cache", () => {
    const db = legacyDatabase();
    db.exec("PRAGMA foreign_keys = OFF; DROP TABLE memory_index_chunks");
    db.exec(MEMORY_INDEX_CHUNKS_SCHEMA_SQL);
    db.exec(`INSERT INTO memory_index_chunks(id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES('logical-id', 'memory/a.md', 'memory', 1, 2, 'h', 'model', 'saffronquasar', X'01', 123)`);
    db.exec("PRAGMA foreign_keys = ON");
    const before = snapshot(db);
    expect(() => migrateMemoryIndexStorage(db)).toThrow("invalid binary embeddings");
    expect(snapshot(db)).toEqual(before);
  });

  it("preserves existing revision triggers and indexes without relying on the outer schema ensure", () => {
    const db = legacyDatabase();
    db.exec(`
      CREATE TABLE memory_index_state (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL) STRICT;
      INSERT INTO memory_index_state VALUES(1, 10);
      CREATE INDEX idx_memory_index_chunks_path_source ON memory_index_chunks(path, source);
      CREATE INDEX idx_memory_index_chunks_path ON memory_index_chunks(path);
      CREATE INDEX idx_memory_embedding_cache_updated_at ON memory_embedding_cache(updated_at);
    `);
    for (const event of ["insert", "update", "delete"]) {
      db.exec(`CREATE TRIGGER memory_index_chunks_revision_after_${event}
        AFTER ${event.toUpperCase()} ON memory_index_chunks
        BEGIN UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1; END;`);
    }
    const indexes = db
      .prepare(
        "SELECT name, sql FROM sqlite_schema WHERE name IN ('idx_memory_index_chunks_path_source', 'idx_memory_index_chunks_path', 'idx_memory_embedding_cache_updated_at') ORDER BY name",
      )
      .all();
    migrateMemoryIndexStorage(db);
    expect(
      db
        .prepare(
          "SELECT name, sql FROM sqlite_schema WHERE name IN ('idx_memory_index_chunks_path_source', 'idx_memory_index_chunks_path', 'idx_memory_embedding_cache_updated_at') ORDER BY name",
        )
        .all(),
    ).toEqual(indexes);
    db.exec(
      "UPDATE memory_index_chunks SET text = 'new searchable text'; DELETE FROM memory_index_chunks",
    );
    expect(db.prepare("SELECT revision FROM memory_index_state").get()).toEqual({ revision: 12 });
  });

  it("waits a full interval after slow authority renewal while preserving converted embeddings", () => {
    const db = legacyDatabase();
    db.exec(`INSERT INTO memory_embedding_cache
      (provider, model, provider_key, hash, embedding, dims, updated_at) VALUES
      ('provider', 'model', 'provider-key', 'second', '[2,3]', 2, 122),
      ('provider', 'model', 'provider-key', 'third', '[4,5]', 2, 123)`);
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const renewAuthority = vi.fn(() => {
      clock += 1_100;
    });
    try {
      migrateMemoryIndexStorage(db, { renewAuthority });
      expect(renewAuthority).toHaveBeenCalledTimes(1);
      expect(
        db.prepare("SELECT hash, embedding FROM memory_embedding_cache ORDER BY hash").all(),
      ).toEqual([
        { hash: "h", embedding: encodeMemoryEmbedding([1 + Number.EPSILON, 0.1]) },
        { hash: "second", embedding: encodeMemoryEmbedding([2, 3]) },
        { hash: "third", embedding: encodeMemoryEmbedding([4, 5]) },
      ]);
      expect(db.prepare("SELECT embedding FROM memory_index_chunks").get()).toEqual({
        embedding: encodeMemoryEmbedding([1 + Number.EPSILON, 0.1]),
      });
    } finally {
      now.mockRestore();
    }
  });

  it("renews long synchronous conversion work periodically and releases the callback afterward", () => {
    const db = legacyDatabase();
    const insert =
      db.prepare(`INSERT INTO memory_index_chunks(id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      SELECT ?, path, source, start_line, end_line, hash, model, text, embedding, updated_at FROM memory_index_chunks WHERE id = 'logical-id'`);
    for (let index = 0; index < 10; index += 1) {
      insert.run(`extra-${index}`);
    }
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => (clock += 250));
    const renewals: number[] = [];
    try {
      migrateMemoryIndexStorage(db, { renewAuthority: () => renewals.push(clock) });
      expect(renewals.length).toBeGreaterThan(1);
      expect(
        renewals.every((instant, index) => index === 0 || instant - renewals[index - 1]! >= 1_000),
      ).toBe(true);
      const count = renewals.length;
      db.prepare("SELECT openclaw_memory_embedding_from_json(?)").get("[2]");
      expect(renewals).toHaveLength(count);
      expect(
        db
          .prepare(
            "SELECT count(*) AS count FROM memory_index_chunks WHERE typeof(embedding) = 'blob'",
          )
          .get(),
      ).toEqual({ count: 11 });
    } finally {
      now.mockRestore();
    }
  });

  it("rolls back admitted changes when authority is lost inside a conversion statement", () => {
    const db = legacyDatabase();
    db.exec("UPDATE memory_index_chunks SET embedding = '[1,null]'");
    const before = snapshot(db);
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => (clock += 1_000));
    let renewals = 0;
    try {
      expect(() =>
        migrateMemoryIndexStorage(db, {
          renewAuthority: () => {
            if (++renewals === 2) {
              throw new Error("migration authority revoked");
            }
          },
        }),
      ).toThrow();
      expect(renewals).toBe(2);
      expect(snapshot(db)).toEqual(before);
    } finally {
      now.mockRestore();
    }
  });
});
