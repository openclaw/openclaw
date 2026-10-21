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

it.each(["clean", "unclean"])(
  "retains reindexed memory admission across a %s restart without skipping required integrity",
  async (shutdown) => {
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
        resize(sourceBackend, 2);
        const resized = resize(sourceBackend, 3);
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
      expect(fs.existsSync(`${target.path}.seal`)).toBe(true);
      if (shutdown === "unclean") {
        fs.unlinkSync(`${target.path}.seal`);
      }
      // Same-process reopen deliberately retains physical proof; only a new process tests the seal.
      const { stdout } = await promisify(execFile)(process.execPath, [
        ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(memoryAdmissionRestartEntrypoint)),
        target.path,
      ]);
      expect(JSON.parse(stdout)).toEqual({
        integrityChecked: shutdown === "unclean",
        // A missing seal requires integrity verification, but the published schema is still valid.
        schemaRebuilt: false,
        ftsAvailable: true,
      });
    });
  },
);
