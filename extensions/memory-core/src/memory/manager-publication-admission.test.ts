import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { openOpenClawAgentDatabaseReadOnly } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import {
  openNodeSqliteDatabase,
  openOpenClawAgentDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
  requireNativeSqliteDatabase,
  closeOpenClawAgentDatabasesAsync,
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
import { readMemoryDatabaseRevision } from "./manager-db-kernel.js";
import { memoryAdmissionRestartEntrypoint } from "./manager-publication-admission-entrypoint.test-support.js";
import { observePublishedSql } from "./manager-publication-observer.test-support.js";
import type { MemoryPublicationConnection } from "./manager-publication-task.js";
import { bindSqliteWorkerBackend } from "./manager-publication.worker.js";
import { readMemoryConnectionPragmas, readMemoryShadowIdentity } from "./manager-shadow-task.js";

const schema = { cacheEnabled: true, ftsEnabled: true };
const state = {
  fts: { enabled: true, available: true },
  vector: { enabled: true, available: true },
};

function expectRetainedAgentAdmission(databasePath: string) {
  const observed = observeHostDataSql();
  try {
    const reader = openOpenClawAgentDatabaseReadOnly({ agentId: "main", path: databasePath });
    expect(reader.found).toBe(true);
    if (reader.found) {
      reader.database.close();
    }
    const schemaQuery = /sqlite_(?:schema|master)|pragma_table|FROM\s+"?schema_meta/i;
    expect.soft(observed.queries.filter((sql) => schemaQuery.test(sql))).toEqual([]);
  } finally {
    observed.restore();
  }
}

async function admit(
  db: DatabaseSync,
  databasePath: string,
  connection: MemoryPublicationConnection = { kind: "agent" },
) {
  const backend = bindSqliteWorkerBackend(connection, {
    databasePath,
    database: db,
    admit: () => {},
  });
  expect(backend.execute({ type: "schema.admit", input: schema })).toMatchObject({ ok: true });
  if ("kind" in connection) {
    expectRetainedAgentAdmission(databasePath);
  }
  const prepare = { type: "vector.prepare", input: { state } } as const;
  await backend.prepare?.(prepare);
  expect(backend.execute(prepare)).toMatchObject({ ok: true });
  return backend;
}

function resize(backend: ReturnType<typeof bindSqliteWorkerBackend>, dimensions: number) {
  const result = backend.execute({ type: "vector.ensure", input: { dimensions, state } });
  expect(result).toMatchObject({ ok: true });
  return result;
}

it("reuses committed schema repair across worker bindings and repairs later imports", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (fixture) => {
    const target = openOpenClawAgentDatabase({
      agentId: "main",
      path: path.join(fixture.stateDir, "agent.sqlite"),
    });
    const db = requireNativeSqliteDatabase(target.db);
    const initialize = (input = schema) => {
      const backend = bindSqliteWorkerBackend(
        { kind: "agent" },
        { databasePath: target.path, database: db, admit: () => {} },
      );
      try {
        const result = backend.execute({ type: "schema.admit", input });
        expect(result).toMatchObject({ ok: true, value: { ftsAvailable: input.ftsEnabled } });
        return result;
      } finally {
        backend.close();
      }
    };
    initialize();
    const observed = observePublishedSql(db);
    const repairCalls = () =>
      observed
        .calls()
        .filter(({ sql }) =>
          /BEGIN IMMEDIATE|PRAGMA foreign_keys|WITH missing AS MATERIALIZED|SELECT COUNT\(\*\) FROM memory_index_chunks|INSERT INTO memory_index_paths_fts/iu.test(
            sql,
          ),
        );
    try {
      const first = initialize();
      const second = initialize();
      expect(second).toEqual(first);
      expect(repairCalls()).toEqual([]);

      // A sibling import changes data without changing the admitted table contracts.
      using sibling = openNodeSqliteDatabase(target.path);
      sibling.exec(`
        INSERT INTO memory_index_sources (path, source, hash, mtime, size)
          VALUES ('notes.md', 'memory', 'imported', 1, 1);
        INSERT INTO memory_index_chunks
          (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
          VALUES ('imported', 'notes.md', 'memory', 1, 1, 'imported', 'fixture',
                  'searchable import', X'', 17);
        DELETE FROM memory_index_chunks_fts;
        DELETE FROM memory_index_paths_fts;
      `);
      observed.clear();
      initialize();
      expect(repairCalls().some(({ sql }) => /BEGIN IMMEDIATE/iu.test(sql))).toBe(true);
      expect(db.prepare("SELECT origin_class FROM memory_index_chunk_provenance").all()).toEqual([
        { origin_class: "untrusted" },
      ]);
      expect(db.prepare("SELECT hash FROM memory_index_sources").all()).toEqual([{ hash: "" }]);
      expect(
        db
          .prepare(
            "SELECT id FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH 'searchable'",
          )
          .all(),
      ).toEqual([{ id: "imported" }]);
      expect(db.prepare("SELECT path FROM memory_index_paths_fts").all()).toEqual([
        { path: "notes.md" },
      ]);
      observed.clear();
      initialize();
      expect(repairCalls()).toEqual([]);

      initialize({ cacheEnabled: true, ftsEnabled: false });
      observed.clear();
      initialize();
      expect(repairCalls().some(({ sql }) => /BEGIN IMMEDIATE/iu.test(sql))).toBe(true);
      observed.clear();
      initialize();
      expect(repairCalls()).toEqual([]);
    } finally {
      observed.restore();
    }
  });
});

it.each(["commit", "fts", "fts after import"])(
  "does not reuse failed %s repair or bypass request revocation",
  async (failure) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (fixture) => {
      const target = openOpenClawAgentDatabase({
        agentId: "main",
        path: path.join(fixture.stateDir, "agent.sqlite"),
      });
      const db = requireNativeSqliteDatabase(target.db);
      let failRepair = true;
      let revoked = false;
      const backend = bindSqliteWorkerBackend(
        { kind: "agent" },
        {
          databasePath: target.path,
          database: db,
          admit: (stage) => {
            if (revoked || (failRepair && failure === "commit" && stage === "commit")) {
              throw new Error("synthetic admission refusal");
            }
          },
        },
      );
      const observed = observeHostDataSql((sql) => {
        if (
          failRepair &&
          failure.startsWith("fts") &&
          /CREATE VIRTUAL TABLE|SELECT COUNT\(\*\) FROM memory_index_chunks/iu.test(sql)
        ) {
          throw new Error("synthetic FTS failure");
        }
      });
      const initialize = () => backend.execute({ type: "schema.admit", input: schema });
      try {
        if (failure === "fts after import") {
          failRepair = false;
          expect(initialize()).toMatchObject({ ok: true, value: { ftsAvailable: true } });
          db.exec(`INSERT INTO memory_index_sources (path, source, hash, mtime, size)
            VALUES ('imported.md', 'memory', 'imported', 1, 1)`);
          failRepair = true;
        }
        expect(initialize()).toMatchObject(
          failure === "commit"
            ? { ok: false, entered: true, committed: false }
            : { ok: true, value: { ftsAvailable: false } },
        );
        failRepair = false;
        observed.queries.length = 0;
        expect(initialize()).toMatchObject({ ok: true, value: { ftsAvailable: true } });
        expect(observed.queries.some((sql) => /BEGIN IMMEDIATE/iu.test(sql))).toBe(true);
        observed.queries.length = 0;
        revoked = true;
        expect(initialize).toThrow("synthetic admission refusal");
        expect(observed.queries).toEqual([]);
        revoked = false;
        expect(initialize()).toMatchObject({ ok: true, value: { ftsAvailable: true } });
        expect(observed.queries.some((sql) => /BEGIN IMMEDIATE/iu.test(sql))).toBe(false);
      } finally {
        observed.restore();
        backend.close();
      }
    });
  },
);

it("preserves memory schema admission when a fresh handle reuses repair then replaces vectors", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (fixture) => {
    const target = openOpenClawAgentDatabase({
      agentId: "main",
      path: path.join(fixture.stateDir, "agent.sqlite"),
    });
    const first = bindSqliteWorkerBackend(
      { kind: "agent" },
      { databasePath: target.path, database: target.db, admit: () => {} },
    );
    expect(first.execute({ type: "schema.admit", input: schema })).toMatchObject({ ok: true });
    first.close();
    using db = openNodeSqliteDatabase(target.path, { allowExtension: true });
    const backend = await admit(db, target.path, {
      fileIdentity: readMemoryShadowIdentity(target.path),
      pragmas: readMemoryConnectionPragmas(db, "Unable to read fixture pragmas"),
    });
    try {
      resize(backend, 2);
      const observed = observePublishedSql(db);
      try {
        expect(backend.execute({ type: "schema.admit", input: schema })).toMatchObject({
          ok: true,
        });
        expect(
          observed
            .calls()
            .filter(({ sql }) =>
              /sqlite_(?:schema|master)|pragma_(?:table|index)|PRAGMA main\.table_xinfo|\b(?:CREATE|ALTER|DROP)\b/iu.test(
                sql,
              ),
            ),
        ).toEqual([]);
      } finally {
        observed.restore();
      }
    } finally {
      backend.close();
    }
  });
});

it.each(["valid", "invalid"])(
  "retains reindexed memory admission with a %s seal without skipping required integrity",
  async (seal) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (fixture) => {
      const target = openOpenClawAgentDatabase({
        agentId: "main",
        path: path.join(fixture.stateDir, "agent.sqlite"),
      });
      const db = requireNativeSqliteDatabase(target.db);
      const backend = await admit(db, target.path);
      const sourcePath = path.join(fixture.stateDir, "shadow.sqlite");
      using source = openNodeSqliteDatabase(sourcePath, { allowExtension: true });
      const sourceBackend = await admit(source, sourcePath, {
        fileIdentity: readMemoryShadowIdentity(sourcePath),
        pragmas: readMemoryConnectionPragmas(source, "Unable to read shadow fixture pragmas"),
      });
      try {
        // Dimension changes and publication both replace virtual tables.
        for (const dimensions of [2, 3]) {
          resize(backend, dimensions);
        }
        const observed = observePublishedSql(source);
        let resized: ReturnType<typeof resize>;
        try {
          resize(sourceBackend, 2);
          expect(observed.calls().filter(({ sql }) => /DROP TABLE/i.test(sql))).toHaveLength(0);
          observed.clear();
          resized = resize(sourceBackend, 3);
          expect(observed.calls().filter(({ sql }) => /DROP TABLE/i.test(sql))).toHaveLength(1);
        } finally {
          observed.restore();
        }
        assert.ok(resized && typeof resized === "object" && "ok" in resized && resized.ok);
        assert.ok(resized.searchSchema);
        expect(resized.searchSchema.vector).toContain("FLOAT[3]");
        source.exec(`
          INSERT INTO memory_index_sources (path, source, hash, mtime, size)
            VALUES ('memory/reindexed.md', 'memory', 'new', 1, 1);
          INSERT INTO memory_index_chunks
            (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
            VALUES ('reindexed', 'memory/reindexed.md', 'memory', 1, 1, 'new',
                    'fixture', 'replacement searchable', X'', 1);
          INSERT INTO memory_index_chunks_vec VALUES ('reindexed', '[0,1,0]');
        `);
        expect(
          backend.execute({
            type: "database.publish",
            input: {
              sourcePath,
              sourceIdentity: readMemoryShadowIdentity(sourcePath),
              metaKey: "memory_index_meta_v1",
              expectedRevision: readMemoryDatabaseRevision(db),
              sourceSchema: resized.searchSchema,
              vectorIndexComplete: true,
              state,
            },
          }),
        ).toMatchObject({ ok: true });
        expectRetainedAgentAdmission(target.path);
        expect(
          target.db
            .prepare(
              "SELECT id FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH 'replacement'",
            )
            .all(),
        ).toEqual([{ id: "reindexed" }]);
        expect(target.db.prepare("SELECT id FROM memory_index_chunks_vec").all()).toEqual([
          { id: "reindexed" },
        ]);
      } finally {
        sourceBackend.close();
        backend.close();
      }
      await closeOpenClawAgentDatabasesAsync();
      const { payload } = JSON.parse(fs.readFileSync(`${target.path}.seal`, "utf8"));
      const { verifiedAt } = JSON.parse(payload);
      if (seal === "invalid") {
        fs.writeFileSync(`${target.path}.seal`, "interrupted seal write");
      }
      // Same-process reopen deliberately retains physical proof; only a new process tests the seal.
      const { stdout } = await promisify(execFile)(process.execPath, [
        ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(memoryAdmissionRestartEntrypoint)),
        target.path,
        String(verifiedAt),
      ]);
      expect(JSON.parse(stdout)).toEqual({
        integrityChecked: seal === "invalid",
        // An invalid seal requires full verification, but the published schema is still valid.
        schemaRebuilt: false,
        ftsAvailable: true,
      });
    });
  },
);
