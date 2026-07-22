// Memory Core tests cover deleted-file cleanup after same-file legacy migration.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./test-runtime-mocks.js";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import type { MemoryIndexManager } from "./manager.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;

describe("memory legacy migration cleanup", () => {
  let fixtureRoot = "";
  let workspaceDir = "";
  let manager: MemoryIndexManager | undefined;

  beforeEach(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-migration-cleanup-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", path.join(fixtureRoot, "state"));
  });

  afterEach(async () => {
    await manager?.close();
    manager = undefined;
    await closeAllMemorySearchManagers();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    if (originalStateDir === undefined) {
      Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
    } else {
      Reflect.set(process.env, "OPENCLAW_STATE_DIR", originalStateDir);
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("removes migrated chunks and FTS rows when the dirty source file is already deleted", async () => {
    const dbPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const seedDb = new DatabaseSync(dbPath);
    try {
      ensureMemoryIndexSchema({ db: seedDb, cacheEnabled: false, ftsEnabled: true });
      seedDb.exec(`
        INSERT INTO memory_index_sources (path, source, hash, mtime, size)
          VALUES ('memory/deleted.md', 'memory', 'canonical-hash', 200, 20);
        INSERT INTO memory_index_chunks VALUES (
          'chunk-canonical', 'memory/deleted.md', 'memory', 1, 2, 'canonical-chunk-hash',
          'fts-only', 'obsolete saffronquasar', '[]', 200
        );
        INSERT INTO memory_index_chunks VALUES (
          'chunk-ownerless', 'memory/ownerless.md', 'memory', 1, 2, 'ownerless-chunk-hash',
          'fts-only', 'obsolete ambercomet', '[]', 190
        );
        INSERT INTO memory_index_chunks_fts
          (text, id, path, source, model, start_line, end_line)
        VALUES
          (
            'obsolete saffronquasar', 'chunk-canonical', 'memory/deleted.md',
            'memory', 'fts-only', 1, 2
          ),
          (
            'obsolete ambercomet', 'chunk-ownerless', 'memory/ownerless.md',
            'memory', 'fts-only', 1, 2
          );
        CREATE TABLE memory_index_chunks_vec (id TEXT PRIMARY KEY, embedding BLOB);
        INSERT INTO memory_index_chunks_vec VALUES ('chunk-canonical', X'00000000');
        INSERT INTO memory_index_chunks_vec VALUES ('chunk-ownerless', X'00000000');

        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE files (
          path TEXT PRIMARY KEY,
          source TEXT NOT NULL DEFAULT 'memory',
          hash TEXT NOT NULL,
          mtime INTEGER NOT NULL,
          size INTEGER NOT NULL
        );
        CREATE TABLE chunks (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'memory',
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          hash TEXT NOT NULL,
          model TEXT NOT NULL,
          text TEXT NOT NULL,
          embedding TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO files VALUES (
          'memory/deleted.md', 'memory', 'legacy-hash', 100, 10
        );
        INSERT INTO chunks VALUES (
          'chunk-legacy-extra', 'memory/deleted.md', 'memory', 3, 4, 'legacy-chunk-hash',
          'fts-only', 'stale legacy tail', '[]', 100
        );
      `);
    } finally {
      seedDb.close();
    }

    const cfg = {
      memory: { backend: "builtin" },
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "none",
            model: "",
            store: { vector: { enabled: true } },
            cache: { enabled: false },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { hybrid: { enabled: true } },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) {
      throw new Error(result.error ?? "memory manager missing");
    }
    manager = result.manager as unknown as MemoryIndexManager;
    expect(manager.status().fts?.available).toBe(true);

    const db = Reflect.get(manager, "db") as DatabaseSync;
    expect(
      db
        .prepare("SELECT hash FROM memory_index_sources WHERE path = 'memory/deleted.md'")
        .get(),
    ).toEqual({ hash: "" });
    expect(
      db
        .prepare("SELECT hash FROM memory_index_sources WHERE path = 'memory/ownerless.md'")
        .get(),
    ).toEqual({ hash: "" });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM memory_index_chunks WHERE path = ?")
        .get("memory/deleted.md"),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM memory_index_chunks_fts WHERE path = ?")
        .get("memory/deleted.md"),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM memory_index_chunks_fts WHERE path = ?")
        .get("memory/ownerless.md"),
    ).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM memory_index_chunks_vec").get()).toEqual({
      count: 2,
    });

    await (
      manager as unknown as {
        syncMemoryFiles(params: { needsFullReindex: boolean }): Promise<unknown>;
      }
    ).syncMemoryFiles({ needsFullReindex: false });

    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM memory_index_sources WHERE path = ?")
        .get("memory/deleted.md"),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM memory_index_chunks WHERE path = ?")
        .get("memory/deleted.md"),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM memory_index_chunks_fts WHERE path = ?")
        .get("memory/deleted.md"),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM memory_index_sources WHERE path = ?")
        .get("memory/ownerless.md"),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM memory_index_chunks WHERE path = ?")
        .get("memory/ownerless.md"),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM memory_index_chunks_fts WHERE path = ?")
        .get("memory/ownerless.md"),
    ).toEqual({ count: 0 });
    // Cleanup ran while vectors were disabled, so the old rows remain until the
    // vector owner loads again and reconciles them against canonical chunks.
    expect(db.prepare("SELECT COUNT(*) AS count FROM memory_index_chunks_vec").get()).toEqual({
      count: 2,
    });
    (
      manager as unknown as {
        pruneOrphanedVectorRows(): void;
      }
    ).pruneOrphanedVectorRows();
    expect(db.prepare("SELECT COUNT(*) AS count FROM memory_index_chunks_vec").get()).toEqual({
      count: 0,
    });
  });
});
