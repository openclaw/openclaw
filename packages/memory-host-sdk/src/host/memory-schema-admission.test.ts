import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../../../../src/infra/node-sqlite.js";
import {
  captureSqliteDatabaseAdmissions,
  prepareSqliteDatabaseCleanClose,
  revokeSqliteDatabaseAdmissions,
} from "../../../../src/infra/sqlite-database-admission.js";
import { assertSqliteIntegrity } from "../../../../src/infra/sqlite-integrity.js";
import { admitSqliteSchema } from "../../../../src/infra/sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "../../../../src/infra/sqlite-transaction.js";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const schemaSql =
  /sqlite_(?:schema|master)|pragma_(?:table|index|foreign_key)|\bPRAGMA\s+(?:main\.)?(?:user_version|schema_version|integrity_check|quick_check|foreign_key_check|table_info|table_xinfo|index_list|index_info|index_xinfo)\b|\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|TRIGGER|VIRTUAL)\b/iu;

function schemaEntry(db: DatabaseSync, name: string) {
  return db.prepare("SELECT name FROM sqlite_schema WHERE name = ?").get(name);
}

function ftsMatches(db: DatabaseSync, word: string) {
  return db
    .prepare("SELECT id FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ?")
    .all(word);
}

function insertChunk(db: DatabaseSync, id: string, text = "body") {
  db.prepare(`INSERT INTO memory_index_chunks
    (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
    VALUES (?, 'notes.md', 'memory', 1, 1, 'hash', 'model', ?, X'', 17)`).run(id, text);
}

function ensure(db: DatabaseSync, enabled = true) {
  return ensureMemoryIndexSchema({ db, cacheEnabled: enabled, ftsEnabled: enabled });
}

function expectSchema(db: DatabaseSync, enabled = true) {
  expect(ensure(db, enabled)).toEqual({ ftsAvailable: enabled });
}

function observe(before?: Parameters<typeof observeHostDataSql>[0]) {
  const observed = observeHostDataSql(before);
  return {
    expectAdmission(db: DatabaseSync, reused = true, enabled = true) {
      observed.queries.length = 0;
      expectSchema(db, enabled);
      const schema = observed.queries.filter((sql) => schemaSql.test(sql));
      if (reused) {
        expect(schema).toEqual([]);
      } else {
        expect(schema.length).toBeGreaterThan(0);
      }
    },
    [Symbol.dispose]() {
      observed.restore();
    },
  };
}

it.each(["clean", "missing seal"])("reopens after %s without losing schema repair", (close) => {
  const filename = path.join(tempDirs.make("memory-admission-seal-"), "memory.sqlite");
  {
    using db = openNodeSqliteDatabase(filename);
    admitSqliteSchema(db);
    ensure(db);
    assertSqliteIntegrity(db, "memory index");
    using seal = prepareSqliteDatabaseCleanClose(db);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    expect(seal.publish()).toBe(true);
  }
  expect(captureSqliteDatabaseAdmissions().filter((entry) => entry.location === filename)).toEqual(
    [],
  );
  if (close === "missing seal") {
    fs.unlinkSync(`${filename}.seal`);
  }
  using db = openNodeSqliteDatabase(filename);
  admitSqliteSchema(db);
  using observed = observe();
  observed.expectAdmission(db, close === "clean");
  db.exec("DROP INDEX idx_memory_index_chunks_source");
  ensure(db);
  expect(schemaEntry(db, "idx_memory_index_chunks_source")).toEqual({
    name: "idx_memory_index_chunks_source",
  });
});

it.each(["commit", "rollback", "later DDL", "revocation"])(
  "publishes only final committed initialization after %s",
  (outcome) => {
    const filename = path.join(tempDirs.make("memory-admission-transaction-"), "memory.sqlite");
    using db = openNodeSqliteDatabase(filename);
    admitSqliteSchema(db);
    using peer = openNodeSqliteDatabase(filename);
    const transact = () =>
      runSqliteImmediateTransactionSync(db, () => {
        ensure(db);
        if (outcome === "rollback") {
          throw new Error("synthetic initialization rollback");
        }
        if (outcome === "later DDL") {
          db.exec("DROP TABLE memory_index_sources");
        }
        if (outcome === "revocation") {
          revokeSqliteDatabaseAdmissions(peer);
        }
      });
    if (outcome === "rollback") {
      expect(transact).toThrow("synthetic initialization rollback");
    } else {
      transact();
    }
    using observed = observe();
    observed.expectAdmission(db, outcome === "commit");
    expect(db.prepare("SELECT path FROM memory_index_sources").all()).toEqual([]);
  },
);

it("skips fresh-shadow legacy inspection and data repair but backfills later imports", () => {
  const filename = path.join(tempDirs.make("memory-admission-"), "memory.sqlite");
  using sibling = openNodeSqliteDatabase(filename);
  admitSqliteSchema(sibling);
  const legacyInspections = {
    retiredFormat: /PRAGMA main\.table_xinfo\(meta\)/iu,
    storageShape: /SELECT name, type FROM pragma_table_info/iu,
    recallColumns: /PRAGMA table_info\(memory_index_chunks\)/iu,
    sourceIdentity: /PRAGMA main\.table_xinfo\(memory_index_sources\)/iu,
    retiredIndex: /DROP INDEX IF EXISTS idx_memory_index_chunks_path;/iu,
    strictMigration: /PRAGMA (?:main\.)?table_list\b/iu,
    ftsObjects: /SELECT type, name, sql FROM sqlite_schema/iu,
  };
  const legacySql: string[] = [];
  const dataRepairSql: string[] = [];
  using observed = observe((sql) => {
    legacySql.push(sql);
    if (
      /\bWITH missing AS MATERIALIZED\b|\bSELECT COUNT\(\*\) FROM memory_index_chunks\b|^\s*(?:DELETE FROM|INSERT INTO) memory_index_(?:chunks_fts|paths_fts)\b/iu.test(
        sql,
      )
    ) {
      dataRepairSql.push(sql);
    }
  });
  expect(
    ensureMemoryIndexSchema({
      db: sibling,
      cacheEnabled: true,
      ftsEnabled: true,
      fresh: true,
    }),
  ).toEqual({ ftsAvailable: true });
  expect(dataRepairSql).toEqual([]);
  for (const [kind, pattern] of Object.entries(legacyInspections)) {
    expect
      .soft(
        legacySql.filter((sql) => pattern.test(sql)),
        kind,
      )
      .toEqual([]);
  }
  for (let opening = 0; opening < 2; opening++) {
    using db = openNodeSqliteDatabase(filename);
    observed.expectAdmission(db);
    insertChunk(db, `import-${opening}`);
    db.exec(`
          INSERT OR IGNORE INTO memory_index_sources (path, source, hash, mtime, size)
            VALUES ('notes.md', 'memory', 'hash', 1, 1);
          DELETE FROM memory_index_chunks_fts;
          DELETE FROM memory_index_paths_fts;
        `);
    observed.expectAdmission(db);
    const provenance = db.prepare(
      "SELECT origin_class FROM memory_index_chunk_provenance WHERE chunk_id = ?",
    );
    expect(provenance.get(`import-${opening}`)).toEqual({ origin_class: "untrusted" });
    expect(ftsMatches(db, "body")).toHaveLength(opening + 1);
    const paths = db.prepare("SELECT path FROM memory_index_paths_fts").all();
    expect(paths).toEqual([{ path: "notes.md" }]);
  }
});

it("retries transient FTS initialization failure on a later handle", () => {
  const filename = path.join(tempDirs.make("memory-admission-retry-"), "memory.sqlite");
  let failFts = true;
  using observed = observe((sql) => {
    if (failFts && /\bCREATE\s+VIRTUAL\s+TABLE\b/iu.test(sql)) {
      failFts = false;
      throw Object.assign(new Error("database is locked"), { errcode: 5 });
    }
  });
  {
    using db = openNodeSqliteDatabase(filename);
    expect(ensure(db)).toEqual({
      ftsAvailable: false,
      ftsError: expect.stringContaining("database is locked"),
    });
    insertChunk(db, "retry", "recovered body");
  }
  using db = openNodeSqliteDatabase(filename);
  expectSchema(db);
  expect(ftsMatches(db, "recovered")).toEqual([{ id: "retry" }]);
  observed.expectAdmission(db);
});

it("admits changed options and rejects schema drift in a replacement file", () => {
  const filename = path.join(tempDirs.make("memory-admission-replace-"), "memory.sqlite");
  {
    using db = openNodeSqliteDatabase(filename);
    expectSchema(db, false);
    expectSchema(db);
    expectSchema(db, false);
    {
      using observed = observe();
      observed.expectAdmission(db, true, false);
    }
    expect(schemaEntry(db, "memory_index_chunks_fts")).toBeUndefined();
  }
  const replacement = `${filename}.replacement`;
  fs.copyFileSync(filename, replacement);
  {
    using db = new DatabaseSync(replacement);
    db.exec("ALTER TABLE memory_index_sources ADD COLUMN unexpected TEXT");
  }
  fs.renameSync(replacement, filename);
  using db = openNodeSqliteDatabase(filename);
  expect(() => ensure(db, false)).toThrow("canonical memory source identity schema is invalid");
});
