import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../../../../src/infra/node-sqlite.js";
import { revokeSqliteDatabaseAdmissions } from "../../../../src/infra/sqlite-database-admission.js";
import { admitSqliteSchema } from "../../../../src/infra/sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "../../../../src/infra/sqlite-transaction.js";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function schemaStatements(queries: string[]): string[] {
  return queries.filter((sql) =>
    /sqlite_(?:schema|master)|pragma_(?:table|index|foreign_key)|\bPRAGMA\s+(?:main\.)?(?:user_version|schema_version|integrity_check|quick_check|foreign_key_check|table_info|table_xinfo|index_list|index_info|index_xinfo)\b|\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|TRIGGER|VIRTUAL)\b/iu.test(
      sql,
    ),
  );
}

describe("memory physical schema admission", () => {
  it.each(["commit", "rollback", "later DDL", "revocation"])(
    "publishes only final committed initialization after %s",
    (outcome) => {
      const filename = path.join(tempDirs.make("memory-admission-transaction-"), "memory.sqlite");
      using db = openNodeSqliteDatabase(filename);
      admitSqliteSchema(db);
      using peer = openNodeSqliteDatabase(filename);
      const initialize = () =>
        ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: true });
      const transact = () =>
        runSqliteImmediateTransactionSync(db, () => {
          initialize();
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
      const observed = observeHostDataSql();
      try {
        expect(initialize()).toEqual({ ftsAvailable: true });
        if (outcome === "commit") {
          expect(schemaStatements(observed.queries)).toEqual([]);
        } else {
          expect(schemaStatements(observed.queries).length).toBeGreaterThan(0);
        }
        expect(db.prepare("SELECT path FROM memory_index_sources").all()).toEqual([]);
      } finally {
        observed.restore();
      }
    },
  );

  it("reuses admission across handles while backfilling newly imported rows", () => {
    const filename = path.join(tempDirs.make("memory-admission-"), "memory.sqlite");
    const observed = observeHostDataSql();
    try {
      for (let opening = 0; opening < 2; opening++) {
        using db = openNodeSqliteDatabase(filename);
        observed.queries.length = 0;
        expect(ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: true })).toEqual({
          ftsAvailable: true,
        });
        if (opening === 0) {
          expect(schemaStatements(observed.queries).length).toBeGreaterThan(0);
        } else {
          expect(schemaStatements(observed.queries)).toEqual([]);
        }
        db.prepare(`INSERT INTO memory_index_chunks
          (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
          VALUES (?, 'notes.md', 'memory', 1, 1, 'hash', 'model', 'body', X'', 17)
        `).run(`import-${opening}`);
        db.exec(`
          INSERT OR IGNORE INTO memory_index_sources (path, source, hash, mtime, size)
            VALUES ('notes.md', 'memory', 'hash', 1, 1);
          DELETE FROM memory_index_chunks_fts;
          DELETE FROM memory_index_paths_fts;
        `);
        observed.queries.length = 0;
        ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: true });
        expect(schemaStatements(observed.queries)).toEqual([]);
        expect(
          db
            .prepare("SELECT origin_class FROM memory_index_chunk_provenance WHERE chunk_id = ?")
            .get(`import-${opening}`),
        ).toEqual({ origin_class: "untrusted" });
        expect(
          db
            .prepare(
              "SELECT id FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH 'body'",
            )
            .all(),
        ).toHaveLength(opening + 1);
        expect(db.prepare("SELECT path FROM memory_index_paths_fts").all()).toEqual([
          { path: "notes.md" },
        ]);
      }
    } finally {
      observed.restore();
    }
  });

  it("retries transient FTS initialization failure on a later handle", () => {
    const filename = path.join(tempDirs.make("memory-admission-retry-"), "memory.sqlite");
    let failFts = true;
    const observed = observeHostDataSql((sql) => {
      if (failFts && /\bCREATE\s+VIRTUAL\s+TABLE\b/iu.test(sql)) {
        failFts = false;
        throw Object.assign(new Error("database is locked"), { errcode: 5 });
      }
    });
    try {
      {
        using db = openNodeSqliteDatabase(filename);
        expect(ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: true })).toEqual({
          ftsAvailable: false,
          ftsError: expect.stringContaining("database is locked"),
        });
        db.exec(`INSERT INTO memory_index_chunks
          (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
          VALUES ('retry', 'notes.md', 'memory', 1, 1, 'hash', 'model', 'recovered body', X'', 17)
        `);
      }
      using db = openNodeSqliteDatabase(filename);
      expect(ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: true })).toEqual({
        ftsAvailable: true,
      });
      expect(
        db
          .prepare(
            "SELECT id FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH 'recovered'",
          )
          .all(),
      ).toEqual([{ id: "retry" }]);
      observed.queries.length = 0;
      expect(ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: true })).toEqual({
        ftsAvailable: true,
      });
      expect(schemaStatements(observed.queries)).toEqual([]);
    } finally {
      observed.restore();
    }
  });

  it("admits changed options and rejects schema drift in a replacement file", () => {
    const filename = path.join(tempDirs.make("memory-admission-replace-"), "memory.sqlite");
    {
      using db = openNodeSqliteDatabase(filename);
      expect(ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false })).toEqual({
        ftsAvailable: false,
      });
      expect(ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: true })).toEqual({
        ftsAvailable: true,
      });
      expect(ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false })).toEqual({
        ftsAvailable: false,
      });
      const observed = observeHostDataSql();
      try {
        expect(ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false })).toEqual({
          ftsAvailable: false,
        });
        expect(schemaStatements(observed.queries)).toEqual([]);
      } finally {
        observed.restore();
      }
      expect(
        db.prepare("SELECT name FROM sqlite_schema WHERE name = 'memory_index_chunks_fts'").get(),
      ).toBeUndefined();
    }
    const replacement = `${filename}.replacement`;
    fs.copyFileSync(filename, replacement);
    {
      using db = new DatabaseSync(replacement);
      db.exec("ALTER TABLE memory_index_sources ADD COLUMN unexpected TEXT");
    }
    fs.renameSync(replacement, filename);
    using db = openNodeSqliteDatabase(filename);
    expect(() => ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false })).toThrow(
      "canonical memory source identity schema is invalid",
    );
  });
});
