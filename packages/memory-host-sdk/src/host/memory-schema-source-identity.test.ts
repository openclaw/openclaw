import path from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../../../../src/infra/node-sqlite.js";
import { trackSqliteStatementExecutions } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { ensureMemoryIndexSchema, migrateMemoryIndexSourcesIdentity } from "./memory-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("memory index source identity", () => {
  it.each([
    { mode: "tracked transaction", tracked: true, transaction: true, reads: 1 },
    { mode: "untracked transaction", tracked: false, transaction: true, reads: 4 },
    { mode: "standalone", tracked: true, transaction: false, reads: 4 },
  ])("bounds source-column inspection within a $mode", ({ tracked, transaction, reads }) => {
    using db = tracked ? openNodeSqliteDatabase(":memory:") : new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
    db.exec(`INSERT INTO memory_index_sources (id, path, source, hash, mtime, size)
      VALUES (7, 'kept.md', 'memory', 'hash', 1, 2)`);
    if (transaction) {
      db.exec("BEGIN IMMEDIATE");
    }
    const observed = trackSqliteStatementExecutions(db, ["columns"], (sql) =>
      sql === "PRAGMA main.table_xinfo(memory_index_sources)" ? "columns" : null,
    );
    try {
      migrateMemoryIndexSourcesIdentity(db);
      expect(observed.counts.columns).toBe(reads);
      expect(db.prepare("SELECT id, path, hash FROM memory_index_sources").get()).toEqual({
        id: 7,
        path: "kept.md",
        hash: "hash",
      });
    } finally {
      observed.restore();
      if (transaction) {
        db.exec("ROLLBACK");
      }
    }
  });

  it("rereads source columns after local rollback and foreign schema changes", () => {
    const filename = path.join(tempDirs.make("memory-source-columns-"), "memory.sqlite");
    using db = openNodeSqliteDatabase(filename);
    ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
    db.exec("BEGIN IMMEDIATE");
    migrateMemoryIndexSourcesIdentity(db);
    db.exec("ALTER TABLE memory_index_sources ADD COLUMN unexpected TEXT");
    expect(() => migrateMemoryIndexSourcesIdentity(db)).toThrow(
      "canonical memory source identity schema is invalid",
    );
    db.exec("ROLLBACK; BEGIN IMMEDIATE");
    expect(() => migrateMemoryIndexSourcesIdentity(db)).not.toThrow();
    db.exec("COMMIT");
    {
      using foreign = new DatabaseSync(filename);
      foreign.exec("ALTER TABLE memory_index_sources ADD COLUMN unexpected TEXT");
    }
    db.exec("BEGIN IMMEDIATE");
    expect(() => migrateMemoryIndexSourcesIdentity(db)).toThrow(
      "canonical memory source identity schema is invalid",
    );
    db.exec("ROLLBACK");
  });

  it.skipIf(typeof DatabaseSync.prototype.setAuthorizer !== "function")(
    "keeps source-column reads subject to a changing authorizer",
    () => {
      using db = openNodeSqliteDatabase(":memory:");
      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
      db.exec("BEGIN IMMEDIATE");
      let allow = true;
      db.setAuthorizer(() => (allow ? constants.SQLITE_OK : constants.SQLITE_DENY));
      const observed = trackSqliteStatementExecutions(db, ["columns"], (sql) =>
        sql === "PRAGMA main.table_xinfo(memory_index_sources)" ? "columns" : null,
      );
      try {
        migrateMemoryIndexSourcesIdentity(db);
        expect(observed.counts.columns).toBe(4);
        allow = false;
        expect(() => migrateMemoryIndexSourcesIdentity(db)).toThrow(/not authorized/i);
        db.setAuthorizer(null);
        observed.counts.columns = 0;
        migrateMemoryIndexSourcesIdentity(db);
        expect(observed.counts.columns).toBe(1);
      } finally {
        db.setAuthorizer(null);
        observed.restore();
        db.exec("ROLLBACK");
      }
    },
  );
});
