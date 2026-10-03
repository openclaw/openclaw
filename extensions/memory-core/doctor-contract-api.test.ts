import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  encodeMemoryEmbedding,
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { readMemoryHostEventRecords } from "openclaw/plugin-sdk/memory-host-events";
import { openOpenClawStateDatabase } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { createDoctorContext, resetDoctorPluginState } from "./doctor-contract-api.test-support.js";
import { bm25RankToScore, buildFtsQuery } from "./src/memory/keyword-query.js";
import { runVectorKnnQuery } from "./src/memory/manager-search-knn.js";
import { searchKeyword } from "./src/memory/manager-search.js";
import { resetMemoryCoreDreamingStateForTests } from "./src/test-helpers.js";

type AuthoredAgents = NonNullable<OpenClawConfig["agents"]>;
type AuthoredEntry = NonNullable<AuthoredAgents["entries"]>[string];
type AuthoredMemory = NonNullable<OpenClawConfig["memory"]>;
type AuthoredMemorySearch = NonNullable<AuthoredMemory["search"]>;
type RawLegacyMemorySearch = Omit<AuthoredMemorySearch, "store"> & {
  store?: NonNullable<AuthoredMemorySearch["store"]> & { path?: string };
};
type RawLegacyDoctorConfig = Omit<OpenClawConfig, "agents" | "memory"> & {
  agents?: Omit<AuthoredAgents, "entries"> & {
    entries?: Record<string, AuthoredEntry & { default?: boolean }>;
    list?: unknown[];
  };
  memory?: Omit<AuthoredMemory, "search"> & { search?: RawLegacyMemorySearch };
  memorySearch?: RawLegacyMemorySearch;
};

function hostEvent(query: string, timestamp = "2026-07-01T00:00:00.000Z") {
  return { type: "memory.recall.recorded" as const, timestamp, query, resultCount: 0, results: [] };
}

function writeEvents(filePath: string, events: ReturnType<typeof hostEvent>[]) {
  return fs.writeFile(filePath, `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function getMigration(id: string) {
  const entry = stateMigrations.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`Missing migration: ${id}`);
  }
  return entry;
}

const legacyMemoryIndexMigration = () =>
  getMigration("memory-core-legacy-sidecar-index-to-agent-sqlite");
const hostEventsMigration = () => getMigration("memory-core-host-events-jsonl-to-sqlite");

function vectorToBlob(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

function insertCanonicalChunkProvenance(
  db: DatabaseSync,
  chunkId: string,
  observedAt: number,
): void {
  db.prepare(
    `INSERT INTO memory_index_chunk_provenance (
       chunk_id, origin_class, session_kind, observed_at
     ) VALUES (?, 'agent', 'unknown', ?)`,
  ).run(chunkId, observedAt);
}

async function writeLegacyMemorySidecar(
  legacyPath: string,
  params: {
    vector?: boolean | "vec0";
    chunkId?: string;
    chunkHash?: string;
    fileHash?: string;
    filePath?: string;
    text?: string;
    cacheEmbedding?: string;
    cacheDims?: number | null;
  } = {},
): Promise<void> {
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  using db = new DatabaseSync(legacyPath, { allowExtension: params.vector === "vec0" });
  const filePath = params.filePath ?? "MEMORY.md";
  const fileHash = params.fileHash ?? "file-hash";
  const chunkId = params.chunkId ?? "chunk-1";
  const chunkHash = params.chunkHash ?? "chunk-hash";
  const text = params.text ?? "remember this";
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE files (
      path TEXT PRIMARY KEY, source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL
    );
    CREATE TABLE chunks (
      id TEXT PRIMARY KEY, path TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, hash TEXT NOT NULL,
      model TEXT NOT NULL, text TEXT NOT NULL, embedding TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE embedding_cache (
      provider TEXT NOT NULL, model TEXT NOT NULL, provider_key TEXT NOT NULL,
      hash TEXT NOT NULL, embedding TEXT NOT NULL, dims INTEGER, updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, model, provider_key, hash)
    );
    INSERT INTO meta VALUES ('memory_index_meta_v1', '{"vectorDims":3}');
  `);
  db.prepare("INSERT INTO files VALUES (?, 'memory', ?, 10, 20)").run(filePath, fileHash);
  db.prepare("INSERT INTO chunks VALUES (?, ?, 'memory', 1, 2, ?, 'embed-model', ?, ?, 30)").run(
    chunkId,
    filePath,
    chunkHash,
    text,
    "[1,0,0]",
  );
  db.prepare(
    "INSERT INTO embedding_cache VALUES ('openai', 'embed-model', 'key', ?, ?, ?, 40)",
  ).run(
    chunkHash,
    params.cacheEmbedding ?? "[1,0,0]",
    params.cacheDims === undefined ? 3 : params.cacheDims,
  );
  if (params.vector === "vec0") {
    const loaded = await loadSqliteVecExtension({ db });
    expect(loaded.ok, loaded.error).toBe(true);
    db.exec(`
      CREATE VIRTUAL TABLE chunks_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[3]
      )
    `);
    db.prepare("INSERT INTO chunks_vec (id, embedding) VALUES (?, ?)").run(
      chunkId,
      vectorToBlob([1, 0, 0]),
    );
  } else if (params.vector) {
    db.exec("CREATE TABLE chunks_vec (id TEXT PRIMARY KEY, embedding BLOB)");
    db.prepare("INSERT INTO chunks_vec (id, embedding) VALUES (?, ?)").run(
      chunkId,
      vectorToBlob([1, 0, 0]),
    );
  }
}

async function createCanonicalMemoryIndex(
  agentPath: string,
  env: NodeJS.ProcessEnv,
  kind: "conflicting" | "unrelated" | "matching",
  options: { vectorDims?: number; ftsText?: string } = {},
) {
  openOpenClawStateDatabase({ env });
  await fs.mkdir(path.dirname(agentPath), { recursive: true });
  using db = new DatabaseSync(agentPath);
  ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: true });
  const fixtures = {
    conflicting: {
      path: "MEMORY.md",
      id: "canonical-chunk",
      fileHash: "canonical-file-hash",
      hash: "canonical-hash",
      text: "canonical memory remains authoritative",
    },
    unrelated: {
      path: "OTHER.md",
      id: "canonical-other-chunk",
      fileHash: "canonical-other-file-hash",
      hash: "canonical-other-hash",
      text: "canonical unrelated memory",
    },
    matching: {
      path: "MEMORY.md",
      id: "chunk-1",
      fileHash: "file-hash",
      hash: "chunk-hash",
      text: "remember this",
    },
  };
  const row = fixtures[kind];
  const matching = kind === "matching";
  db.prepare("INSERT INTO memory_index_meta (key, value) VALUES (?, ?)").run(
    "memory_index_meta_v1",
    JSON.stringify({ vectorDims: options.vectorDims ?? 3 }),
  );
  db.prepare(
    "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, 'memory', ?, ?, ?)",
  ).run(row.path, row.fileHash, matching ? 10 : 11, matching ? 20 : 21);
  db.prepare(
    "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, 'memory', 1, ?, ?, 'embed-model', ?, ?, ?)",
  ).run(
    row.id,
    row.path,
    matching ? 2 : 1,
    row.hash,
    row.text,
    encodeMemoryEmbedding(matching ? [1, 0, 0] : [0, 1, 0]),
    matching ? 30 : 31,
  );
  if (options.ftsText !== undefined) {
    db.prepare("UPDATE memory_index_chunks_fts SET text = ? WHERE id = ?").run(
      options.ftsText,
      row.id,
    );
  }
  insertCanonicalChunkProvenance(db, row.id, matching ? 30 : 31);
}

async function createMismatchedCanonicalVectorIndex(
  agentPath: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  openOpenClawStateDatabase({ env });
  await fs.mkdir(path.dirname(agentPath), { recursive: true });
  using db = new DatabaseSync(agentPath, { allowExtension: true });
  ensureMemoryIndexSchema({
    db,
    cacheEnabled: true,
    ftsEnabled: true,
  });
  const loaded = await loadSqliteVecExtension({ db });
  expect(loaded.ok, loaded.error).toBe(true);
  db.exec(`
      CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[4]
      )
    `);
}

async function createConflictingCanonicalVectorIndex(
  agentPath: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  openOpenClawStateDatabase({ env });
  await fs.mkdir(path.dirname(agentPath), { recursive: true });
  using db = new DatabaseSync(agentPath, { allowExtension: true });
  ensureMemoryIndexSchema({
    db,
    cacheEnabled: true,
    ftsEnabled: true,
  });
  db.prepare("INSERT INTO memory_index_meta (key, value) VALUES (?, ?)").run(
    "memory_index_meta_v1",
    '{"vectorDims":3}',
  );
  const loaded = await loadSqliteVecExtension({ db });
  expect(loaded.ok, loaded.error).toBe(true);
  db.exec(`
      CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[3]
      )
    `);
  db.prepare("INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)").run(
    "chunk-1",
    vectorToBlob([0, 1, 0]),
  );
}

function readMemoryRows(agentPath: string) {
  using db = new DatabaseSync(agentPath);
  return {
    sources: db
      .prepare("SELECT path, source, hash FROM memory_index_sources ORDER BY path, source")
      .all(),
    chunks: db.prepare("SELECT id, text FROM memory_index_chunks ORDER BY id").all(),
    cache: db
      .prepare("SELECT provider, hash FROM memory_embedding_cache ORDER BY provider, hash")
      .all(),
  };
}

function readMemoryCacheRows(agentPath: string) {
  using db = new DatabaseSync(agentPath);
  return db
    .prepare(
      "SELECT provider, model, provider_key, hash, embedding, dims, updated_at FROM memory_embedding_cache ORDER BY provider, hash",
    )
    .all();
}

function readMemoryFtsSql(agentPath: string): string | undefined {
  using db = new DatabaseSync(agentPath);
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE name = ?")
    .get("memory_index_chunks_fts") as { sql?: unknown } | undefined;
  return typeof row?.sql === "string" ? row.sql : undefined;
}

async function searchMigratedVectorRows(agentPath: string) {
  using db = new DatabaseSync(agentPath, { allowExtension: true });
  const loaded = await loadSqliteVecExtension({ db });
  expect(loaded.ok, loaded.error).toBe(true);
  return runVectorKnnQuery(db, {
    vectorTable: "memory_index_chunks_vec",
    providerModels: ["embed-model"],
    queryVec: [1, 0, 0],
    limit: 1,
    snippetMaxChars: 200,
    sourceFilter: { sql: "", params: [] },
  }).rows;
}

async function searchMigratedKeywordRows(agentPath: string, query: string) {
  using db = new DatabaseSync(agentPath);
  return await searchKeyword({
    db,
    ftsTable: "memory_index_chunks_fts",
    query,
    ftsTokenizer: "unicode61",
    limit: 10,
    snippetMaxChars: 200,
    sourceFilter: { sql: "", params: [] },
    buildFtsQuery,
    bm25RankToScore,
  });
}

describe("memory-core doctor dreaming migration", () => {
  let rootDir = "";
  let workspaceDir = "";
  let stateDir = "";
  let legacyPath = "";
  let agentPath = "";
  let eventPath = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    await resetDoctorPluginState();
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-core-doctor-"));
    workspaceDir = path.join(rootDir, "workspace");
    stateDir = path.join(rootDir, "state");
    legacyPath = path.join(stateDir, "memory", "main.sqlite");
    agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    eventPath = path.join(workspaceDir, "memory", ".dreams", "events.jsonl");
    await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(rootDir, "state") };
  });

  afterEach(async () => {
    await resetDoctorPluginState();
    resetMemoryCoreDreamingStateForTests();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  function mainAgents(): NonNullable<RawLegacyDoctorConfig["agents"]> {
    return { defaults: {}, list: [{ id: "main", workspace: workspaceDir }] };
  }

  function context(): PluginDoctorStateMigrationContext {
    return createDoctorContext(env);
  }

  function migrationParams(
    config: RawLegacyDoctorConfig = {
      agents: {
        list: [{ id: "main", workspace: workspaceDir }],
      },
    },
  ) {
    return {
      config,
      env,
      stateDir: path.join(rootDir, "state"),
      oauthDir: path.join(rootDir, "oauth"),
      context: context(),
    };
  }

  it("imports legacy memory host events into plugin state", async () => {
    await writeEvents(eventPath, [hostEvent("sqlite policy")]);
    const migration = hostEventsMigration();
    await expect(migration.detectLegacyState(migrationParams())).resolves.toEqual({
      preview: [expect.stringContaining("Memory Core host events")],
    });
    const store = context().openPluginStateKeyedStore<{
      kind: "event";
      workspaceKey: string;
      event: { type: string; query: string };
      recordedAt: number;
      sequence: number;
    }>({ namespace: "memory-host.events", maxEntries: 10_000 });
    await store.register("runtime-event", {
      kind: "event",
      workspaceKey: path.resolve(workspaceDir).replace(/\\/g, "/"),
      event: {
        type: "memory.recall.recorded",
        query: "runtime after upgrade",
      },
      recordedAt: Date.parse("2026-07-02T00:00:00.000Z"),
      sequence: 1,
    });
    const result = await migration.migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([]);
    const entries = await store.entries();
    const events = entries
      .flatMap((entry) => (entry.value.kind === "event" ? [entry.value] : []))
      .toSorted((left, right) => left.sequence - right.sequence);
    expect(events.map((entry) => entry.event.query)).toEqual([
      "sqlite policy",
      "runtime after upgrade",
    ]);
    expect(events[0]?.sequence).toBeLessThan(0);
    const migratedEntry = entries.find((entry) => entry.value.sequence < 0);
    expect(migratedEntry?.createdAt).toBe(migratedEntry?.value.sequence);
    const cursors = await context()
      .openPluginStateKeyedStore<{ kind: "cursor"; lastSequence: number }>({
        namespace: "memory-host.event-cursors",
        maxEntries: 1_000,
      })
      .entries();
    expect(cursors).toHaveLength(1);
    expect(cursors[0]?.value).toEqual({ kind: "cursor", lastSequence: 1 });
    await fs.access(`${eventPath}.migrated`);
  });

  it("recovers appends written through an open legacy descriptor after archival", async () => {
    await fs.writeFile(eventPath, `${JSON.stringify(hostEvent("before claim"))}\n`, "utf8");
    const oldWriter = await fs.open(eventPath, "a");
    const migration = hostEventsMigration();
    try {
      await migration.migrateLegacyState(migrationParams());
      await fs.writeFile(eventPath, `${JSON.stringify(hostEvent("newer generation"))}\n`, "utf8");
      await migration.migrateLegacyState(migrationParams());
      await oldWriter.appendFile(`${JSON.stringify(hostEvent("late append"))}\n`, "utf8");
      await oldWriter.sync();
    } finally {
      await oldWriter.close();
    }

    await expect(migration.detectLegacyState(migrationParams())).resolves.toEqual({
      preview: [expect.stringContaining("events.jsonl.migrated")],
    });
    const recovered = await migration.migrateLegacyState(migrationParams());

    expect(recovered.warnings).toEqual([]);
    expect(recovered.changes).toEqual([
      expect.stringContaining("Recovered 1 later Memory Core host event row"),
    ]);
    await expect(readMemoryHostEventRecords({ workspaceDir, env })).resolves.toMatchObject([
      { query: "before claim" },
      { query: "newer generation" },
      { query: "late append" },
    ]);
    await expect(
      readMemoryHostEventRecords({ workspaceDir, env, limit: 1 }),
    ).resolves.toMatchObject([{ query: "late append" }]);
    await expect(migration.detectLegacyState(migrationParams())).resolves.toBeNull();

    await fs.writeFile(eventPath, `${JSON.stringify(hostEvent("after recovery generation"))}\n`);
    await migration.migrateLegacyState(migrationParams());
    await expect(
      readMemoryHostEventRecords({ workspaceDir, env, limit: 1 }),
    ).resolves.toMatchObject([{ query: "after recovery generation" }]);
  });

  it("warns without importing when a checkpointed host event archive changes other than by append", async () => {
    const archivedPath = `${eventPath}.migrated`;
    await writeEvents(eventPath, [hostEvent("original archive row")]);
    const migration = hostEventsMigration();
    await migration.migrateLegacyState(migrationParams());
    await writeEvents(archivedPath, [hostEvent("rewritten archive row")]);

    const laterSource = `${JSON.stringify(hostEvent("later generation"))}\n`;
    await fs.writeFile(eventPath, laterSource);
    const result = await migration.migrateLegacyState(migrationParams());

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("changed other than by append")]);
    expect(result).toMatchObject({ warningDisposition: "recoverable" });
    await expect(readMemoryHostEventRecords({ workspaceDir, env })).resolves.toMatchObject([
      { query: "original archive row" },
    ]);
    await expect(fs.readFile(archivedPath, "utf8")).resolves.toContain("rewritten archive row");
    await expect(fs.readFile(eventPath, "utf8")).resolves.toBe(laterSource);

    const invalidWorkspace = path.join(rootDir, "invalid-workspace");
    const invalidPath = path.join(invalidWorkspace, "memory", ".dreams", "events.jsonl");
    await fs.mkdir(path.dirname(invalidPath), { recursive: true });
    await fs.writeFile(invalidPath, "invalid JSON\n");
    const mixed = await migration.migrateLegacyState(
      migrationParams({
        agents: {
          list: [
            { id: "main", workspace: workspaceDir },
            { id: "invalid", workspace: invalidWorkspace },
          ],
        },
      }),
    );
    expect(mixed).not.toHaveProperty("warningDisposition");
    expect(mixed.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("changed other than by append"),
        expect.stringContaining("Skipped malformed Memory Core host event"),
      ]),
    );
    await expect(fs.readFile(invalidPath, "utf8")).resolves.toBe("invalid JSON\n");
  });

  it("refuses to replay a checkpointless older archive after a newer generation", async () => {
    const migration = hostEventsMigration();
    await fs.writeFile(eventPath, `${JSON.stringify(hostEvent("older generation"))}\n`, "utf8");
    await migration.migrateLegacyState(migrationParams());
    await context()
      .openPluginStateKeyedStore({ namespace: "memory-host.events", maxEntries: 10_000 })
      .clear();
    await fs.writeFile(eventPath, `${JSON.stringify(hostEvent("newer generation"))}\n`, "utf8");
    await migration.migrateLegacyState(migrationParams());
    await context()
      .openPluginStateKeyedStore({
        namespace: "memory-host.event-migration-checkpoints",
        maxEntries: 10_000,
        overflowPolicy: "reject-new",
      })
      .clear();

    const replay = await migration.migrateLegacyState(migrationParams());

    expect(replay.changes).toEqual([]);
    expect(replay.warnings).toEqual([
      expect.stringContaining(
        "has no durable checkpoint and later generations are already imported",
      ),
    ]);
    await expect(readMemoryHostEventRecords({ workspaceDir, env })).resolves.toMatchObject([
      { query: "newer generation" },
    ]);
  });

  it("does not import newer host event generations before an older source is repaired", async () => {
    const archivedPath = `${eventPath}.migrated`;
    await fs.writeFile(
      archivedPath,
      `${JSON.stringify(hostEvent("valid before malformed"))}\n${JSON.stringify({
        type: "memory.recall.recorded",
        timestamp: "2026-07-01T00:00:01.000Z",
      })}\n{malformed\n`,
      "utf8",
    );
    await fs.writeFile(eventPath, `${JSON.stringify(hostEvent("newer generation"))}\n`, "utf8");
    const migration = hostEventsMigration();

    const blocked = await migration.migrateLegacyState(migrationParams());

    expect(blocked.changes).toEqual([]);
    expect(blocked.warnings).toEqual([
      expect.stringContaining("Skipped invalid Memory Core host event"),
      expect.stringContaining("Skipped malformed Memory Core host event"),
      expect.stringContaining("invalid rows still require repair"),
    ]);
    await expect(readMemoryHostEventRecords({ workspaceDir, env })).resolves.toEqual([]);
    await fs.access(eventPath);

    await writeEvents(archivedPath, [hostEvent("repaired older generation")]);
    const repaired = await migration.migrateLegacyState(migrationParams());

    expect(repaired.warnings).toEqual([]);
    expect(repaired.changes).toEqual([
      expect.stringContaining("Recovered 1 later Memory Core host event row"),
      "Migrated Memory Core host events -> SQLite plugin state (1 new row(s))",
      expect.stringContaining("Archived Memory Core host events legacy source"),
    ]);
    await expect(readMemoryHostEventRecords({ workspaceDir, env })).resolves.toMatchObject([
      { query: "repaired older generation" },
      { query: "newer generation" },
    ]);
  });

  it.runIf(process.platform !== "win32")(
    "canonicalizes and deduplicates aliased legacy host event sources",
    async () => {
      const workspaceAlias = path.join(rootDir, "workspace-alias");
      await fs.symlink(workspaceDir, workspaceAlias);
      await writeEvents(eventPath, [hostEvent("canonical alias")]);
      const params = migrationParams({
        agents: {
          list: [
            { id: "main", workspace: workspaceDir },
            { id: "alias", workspace: workspaceAlias },
          ],
        },
      });
      const migration = hostEventsMigration();

      await expect(migration.detectLegacyState(params)).resolves.toEqual({
        preview: [expect.stringContaining("Memory Core host events")],
      });
      const result = await migration.migrateLegacyState(params);

      expect(result.warnings).toEqual([]);
      expect(result.changes).toEqual([
        "Migrated Memory Core host events -> SQLite plugin state (1 new row(s))",
        expect.stringContaining("Archived Memory Core host events legacy source"),
      ]);
      await expect(
        readMemoryHostEventRecords({ workspaceDir: workspaceAlias, env }),
      ).resolves.toMatchObject([{ query: "canonical alias" }]);
      await fs.access(`${eventPath}.migrated`);
    },
  );

  it.runIf(process.platform !== "win32")(
    "ignores symlinked memory with no legacy sources",
    async () => {
      const sharedMemory = path.join(rootDir, "shared-memory");
      await fs.mkdir(sharedMemory);
      await fs.rm(path.join(workspaceDir, "memory"), { recursive: true });
      await fs.symlink(sharedMemory, path.join(workspaceDir, "memory"));

      await expect(hostEventsMigration().detectLegacyState(migrationParams())).resolves.toBeNull();
      await expect(hostEventsMigration().migrateLegacyState(migrationParams())).resolves.toEqual({
        changes: [],
        warnings: [],
      });
      expect((await fs.lstat(path.join(workspaceDir, "memory"))).isSymbolicLink()).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects claimed host events beneath symlinked workspace parents",
    async () => {
      const fileName = ".events.jsonl.doctor-importing";
      const externalMemoryDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-memory-core-external-events-"),
      );
      const externalEventPath = path.join(externalMemoryDir, ".dreams", fileName);
      try {
        await fs.rm(path.join(workspaceDir, "memory"), { recursive: true });
        await fs.mkdir(path.dirname(externalEventPath), { recursive: true });
        await writeEvents(externalEventPath, [hostEvent("outside workspace")]);
        await fs.symlink(externalMemoryDir, path.join(workspaceDir, "memory"));

        await expect(hostEventsMigration().detectLegacyState(migrationParams())).resolves.toEqual({
          preview: [expect.stringContaining("Skipped unsafe Memory Core host event source")],
        });
        const result = await hostEventsMigration().migrateLegacyState(migrationParams());

        expect(result.changes).toEqual([]);
        expect(result.warnings).toEqual([
          expect.stringContaining(path.join(workspaceDir, "memory", ".dreams", fileName)),
        ]);
        expect(result.warnings[0]).toContain("memory.search.extraPaths");
        expect(result.warnings[0]).toContain("regular files and directories");
        expect(result.warnings[0]).toContain("FsSafeError: path alias escape blocked");
        expect(result).not.toHaveProperty("warningDisposition");
        await expect(hostEventsMigration().detectLegacyState(migrationParams())).resolves.toEqual({
          preview: result.warnings.map((warning) => `- ${warning}`),
        });
        await expect(fs.readFile(externalEventPath, "utf8")).resolves.toContain(
          "outside workspace",
        );
        await expect(fs.access(`${externalEventPath}.migrated`)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await fs.rm(externalMemoryDir, { recursive: true, force: true });
      }
    },
  );

  it("imports the newest retained tail from an oversized legacy host event log", async () => {
    const events = Array.from({ length: 10_002 }, (_, index) => hostEvent(`oversized-${index}`));
    await writeEvents(eventPath, events);

    const result = await hostEventsMigration().migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Memory Core host events -> SQLite plugin state (10000 new row(s))",
      expect.stringContaining("Archived Memory Core host events legacy source"),
    ]);
    const imported = await readMemoryHostEventRecords({ workspaceDir, env });
    expect(imported).toHaveLength(10_000);
    expect(imported[0]).toMatchObject({ query: "oversized-2" });
    expect(imported.at(-1)).toMatchObject({ query: "oversized-10001" });
    await context()
      .openPluginStateKeyedStore({
        namespace: "memory-host.event-migration-checkpoints",
        maxEntries: 10_000,
        overflowPolicy: "reject-new",
      })
      .clear();
    const retriedWithoutCheckpoint =
      await hostEventsMigration().migrateLegacyState(migrationParams());
    expect(retriedWithoutCheckpoint.warnings).toEqual([]);
    const afterCheckpointRetry = await readMemoryHostEventRecords({ workspaceDir, env });
    expect(afterCheckpointRetry[0]).toMatchObject({ query: "oversized-2" });
    expect(afterCheckpointRetry.at(-1)).toMatchObject({ query: "oversized-10001" });
    await writeEvents(eventPath, [
      hostEvent("newer recreated generation", "2026-07-02T00:00:00.000Z"),
    ]);
    const repeated = await hostEventsMigration().migrateLegacyState(migrationParams());
    expect(repeated.warnings).toEqual([]);
    expect(repeated.changes[0]).toContain("1 new row");
    const afterRepeated = await readMemoryHostEventRecords({ workspaceDir, env });
    expect(afterRepeated).toHaveLength(10_000);
    expect(afterRepeated[0]).toMatchObject({ query: "oversized-3" });
    expect(afterRepeated.at(-1)).toMatchObject({ query: "newer recreated generation" });
    await fs.access(`${eventPath}.migrated`);
    await fs.access(`${eventPath}.migrated.2`);
  });

  it("resumes a partially committed host event import before archiving the source", async () => {
    const events = Array.from({ length: 1_002 }, (_, index) => hostEvent(`resume-${index}`));
    const raw = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    await fs.writeFile(eventPath, raw);
    await context()
      .openPluginStateKeyedStore({ namespace: "memory-host.events", maxEntries: 10_000 })
      .clear();
    // The age-preserving importer owns a native connection distinct from the async store.
    openOpenClawStateDatabase({ env });
    const db = new DatabaseSync(path.join(rootDir, "state", "state", "openclaw.sqlite"));
    try {
      db.exec(`CREATE TRIGGER fail_host_import BEFORE INSERT ON plugin_state_entries
        WHEN NEW.namespace = 'memory-host.events' AND json_extract(NEW.value_json, '$.event.query') = 'resume-750'
        BEGIN SELECT RAISE(ABORT, 'injected host import failure'); END`);
      await expect(hostEventsMigration().migrateLegacyState(migrationParams())).rejects.toThrow(
        "Failed to register plugin state entry",
      );
      const partial = await readMemoryHostEventRecords({ workspaceDir, env });
      expect(partial).toHaveLength(750);
      expect(partial).toMatchObject(events.slice(0, 750));
      await expect(fs.readFile(eventPath, "utf8")).resolves.toBe(raw);
      await expect(fs.access(`${eventPath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        context()
          .openPluginStateKeyedStore({
            namespace: "memory-host.event-migration-checkpoints",
            maxEntries: 10_000,
            overflowPolicy: "reject-new",
          })
          .entries(),
      ).resolves.toEqual([]);
    } finally {
      db.exec("DROP TRIGGER IF EXISTS fail_host_import");
      db.close();
    }
    await resetDoctorPluginState();
    const result = await hostEventsMigration().migrateLegacyState(migrationParams());
    expect(result.warnings).toEqual([]);
    const recovered = await readMemoryHostEventRecords({ workspaceDir, env });
    expect(recovered).toHaveLength(events.length);
    expect(recovered).toMatchObject(events);
    await fs.access(`${eventPath}.migrated`);
    await expect(hostEventsMigration().migrateLegacyState(migrationParams())).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    expect(await readMemoryHostEventRecords({ workspaceDir, env })).toEqual(recovered);
  });

  it("leaves legacy host events in place when plugin-wide SQLite capacity is exhausted", async () => {
    await writeEvents(eventPath, [hostEvent("sqlite capacity")]);
    const params = migrationParams();
    params.context = {
      ...params.context,
      getPluginStateCapacity: () => ({ liveEntries: 50_000, maxEntries: 50_000 }),
    };

    const result = await hostEventsMigration().migrateLegacyState(params);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("no room for its workspace cursor")]);
    await fs.access(eventPath);
    await expect(fs.access(`${eventPath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reserves plugin-wide capacity for the migrated workspace cursor and checkpoint", async () => {
    const events = Array.from({ length: 3 }, (_, index) => hostEvent(`capacity-${index}`));
    await writeEvents(eventPath, events);
    const params = migrationParams();
    params.context = {
      ...params.context,
      getPluginStateCapacity: () => ({ liveEntries: 49_997, maxEntries: 50_000 }),
    };

    const result = await hostEventsMigration().migrateLegacyState(params);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Memory Core host events -> SQLite plugin state (1 new row(s))",
      expect.stringContaining("Archived Memory Core host events legacy source"),
    ]);
    await expect(readMemoryHostEventRecords({ workspaceDir, env })).resolves.toMatchObject([
      { query: "capacity-2" },
    ]);
    const cursors = await context()
      .openPluginStateKeyedStore<{ kind: "cursor"; lastSequence: number }>({
        namespace: "memory-host.event-cursors",
        maxEntries: 1_000,
      })
      .entries();
    expect(cursors).toHaveLength(1);
    const checkpoints = await context()
      .openPluginStateKeyedStore({
        namespace: "memory-host.event-migration-checkpoints",
        maxEntries: 10_000,
        overflowPolicy: "reject-new",
      })
      .entries();
    expect(checkpoints).toHaveLength(1);
  });

  it("retires an empty legacy memory host event source without claiming an import", async () => {
    await fs.writeFile(eventPath, "\n", "utf8");

    const result = await hostEventsMigration().migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Retired empty Memory Core host events legacy source",
      expect.stringContaining("Archived Memory Core host events legacy source"),
    ]);
    const entries = await context()
      .openPluginStateKeyedStore({ namespace: "memory-host.events", maxEntries: 10_000 })
      .entries();
    expect(entries).toEqual([]);
    await fs.access(`${eventPath}.migrated`);
  });

  it("removes an empty legacy memory sidecar placeholder without warning", async () => {
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, "");

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      `Removed empty Memory Core legacy memory index sidecar placeholder: ${legacyPath}`,
    ]);
    await expect(fs.access(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores a legacy sidecar symlink to the populated canonical agent database", async () => {
    await createCanonicalMemoryIndex(agentPath, env, "conflicting");
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.symlink(path.relative(path.dirname(legacyPath), agentPath), legacyPath);

    const migration = legacyMemoryIndexMigration();
    await expect(migration.detectLegacyState(migrationParams())).resolves.toBeNull();
    await expect(migration.migrateLegacyState(migrationParams())).resolves.toEqual({
      changes: [],
      warnings: [],
    });

    expect((await fs.lstat(legacyPath)).isSymbolicLink()).toBe(true);
    await expect(fs.realpath(legacyPath)).resolves.toBe(await fs.realpath(agentPath));
    expect(readMemoryRows(agentPath).chunks).toEqual([
      { id: "canonical-chunk", text: "canonical memory remains authoritative" },
    ]);
  });

  it("keeps the warning for a legacy sidecar symlink to a different data-bearing database", async () => {
    const unrelatedPath = path.join(rootDir, "unrelated.sqlite");
    const db = new DatabaseSync(unrelatedPath);
    try {
      db.exec("CREATE TABLE unrelated (value TEXT)");
      db.prepare("INSERT INTO unrelated (value) VALUES (?)").run("preserve me");
    } finally {
      db.close();
    }
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.symlink(path.relative(path.dirname(legacyPath), unrelatedPath), legacyPath);

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      "Skipped Memory Core legacy memory index import for agent main because the sidecar schema is not a legacy memory index",
    ]);
    expect((await fs.lstat(legacyPath)).isSymbolicLink()).toBe(true);
    await expect(fs.realpath(legacyPath)).resolves.toBe(await fs.realpath(unrelatedPath));
    const preserved = new DatabaseSync(unrelatedPath, { readOnly: true });
    try {
      expect(preserved.prepare("SELECT value FROM unrelated").get()).toEqual({
        value: "preserve me",
      });
    } finally {
      preserved.close();
    }
  });

  it("preserves the main sidecar when a companion stat fails with ELOOP", async () => {
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, "");
    const walPath = `${legacyPath}-wal`;
    await fs.symlink(walPath, walPath);

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

    expect(result.changes).toEqual([]);
    await fs.access(legacyPath);
  });

  it("creates migrated FTS tables with the configured legacy tokenizer", async () => {
    await writeLegacyMemorySidecar(legacyPath);
    const config: RawLegacyDoctorConfig = {
      memory: {
        search: {
          store: {
            fts: { tokenizer: "trigram" },
          },
        },
      },

      agents: mainAgents(),
    };

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams(config));

    expect(result.warnings).toEqual([]);
    expect(readMemoryFtsSql(agentPath)).toContain("tokenize='trigram case_sensitive 0'");
    await fs.access(`${legacyPath}.migrated`);
  });

  it("migrates all retired configured legacy memory sidecar paths", async () => {
    const lockPath = path.join(stateDir, "memory", "main.sqlite.reindex-lock.sqlite");
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, "");
    const topLevelPath = path.join(rootDir, "top-memory", "main.sqlite");
    const defaultsPath = path.join(rootDir, "default-memory", "main.sqlite");
    await writeLegacyMemorySidecar(topLevelPath, {
      chunkId: "chunk-top",
      chunkHash: "chunk-hash-top",
      fileHash: "file-hash-top",
      filePath: "TOP.md",
      text: "remember top level",
    });
    await writeLegacyMemorySidecar(defaultsPath, {
      chunkId: "chunk-defaults",
      chunkHash: "chunk-hash-defaults",
      fileHash: "file-hash-defaults",
      filePath: "DEFAULTS.md",
      text: "remember defaults",
    });
    const config: RawLegacyDoctorConfig = {
      memorySearch: {
        store: {
          path: topLevelPath,
        },
      },
      memory: {
        search: {
          store: {
            path: path.join(rootDir, "default-memory", "{agentId}.sqlite"),
          },
        },
      },

      agents: mainAgents(),
    };

    const migration = legacyMemoryIndexMigration();
    const preview = await migration.detectLegacyState(migrationParams(config));
    expect(preview?.preview).toEqual([
      `- Memory Core legacy memory index: ${defaultsPath} -> ${agentPath}`,
      `- Memory Core legacy memory index: ${topLevelPath} -> ${agentPath}`,
    ]);

    const result = await migration.migrateLegacyState(migrationParams(config));

    expect(result.warnings).toEqual([]);
    expect(
      readMemoryRows(agentPath)
        .chunks.map((chunk) => String(chunk.id))
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["chunk-defaults", "chunk-top"]);
    await fs.access(`${defaultsPath}.migrated`);
    await fs.access(`${topLevelPath}.migrated`);
  });

  it("copies shared retired configured legacy sidecars to each configured agent", async () => {
    legacyPath = path.join(stateDir, "memory", "shared.sqlite");
    const mainAgentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    const workAgentPath = path.join(stateDir, "agents", "work", "agent", "openclaw-agent.sqlite");
    await writeLegacyMemorySidecar(legacyPath);
    const config: RawLegacyDoctorConfig = {
      memory: {
        search: {
          store: {
            path: legacyPath,
          },
        },
      },

      agents: {
        defaults: {},
        list: [
          { id: "main", workspace: workspaceDir },
          { id: "work", workspace: path.join(rootDir, "work") },
        ],
      },
    };

    const migration = legacyMemoryIndexMigration();
    const preview = await migration.detectLegacyState(migrationParams(config));
    expect(preview?.preview).toEqual([
      `- Memory Core legacy memory index: ${legacyPath} -> ${mainAgentPath}`,
      `- Memory Core legacy memory index: ${legacyPath} -> ${workAgentPath}`,
    ]);

    const result = await migration.migrateLegacyState(migrationParams(config));

    expect(result.warnings).toEqual([]);
    for (const canonicalPath of [mainAgentPath, workAgentPath]) {
      expect(readMemoryRows(canonicalPath)).toEqual({
        sources: [{ path: "MEMORY.md", source: "memory", hash: "" }],
        chunks: [{ id: "chunk-1", text: "remember this" }],
        cache: [{ provider: "openai", hash: "chunk-hash" }],
      });
    }
    await expect(fs.access(path.join(stateDir, "agents", "shared"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await fs.access(`${legacyPath}.migrated`);
  });

  it("restores legacy sidecar vector rows for vector-backed search", async () => {
    await writeLegacyMemorySidecar(legacyPath, { vector: true });

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(
      "Migrated Memory Core legacy memory index for agent main -> per-agent SQLite (1 source(s), 1 chunk(s), 1 cache row(s))",
    );
    const rows = await searchMigratedVectorRows(agentPath);
    expect(rows.map((row) => row.id)).toEqual(["chunk-1"]);
    await fs.access(`${legacyPath}.migrated`);
  });

  it("leaves malformed legacy vector sidecars retryable", async () => {
    await writeLegacyMemorySidecar(legacyPath);
    const legacyDb = new DatabaseSync(legacyPath);
    try {
      legacyDb.exec("CREATE TABLE chunks_vec (id TEXT PRIMARY KEY, vector BLOB)");
      legacyDb
        .prepare("INSERT INTO chunks_vec (id, vector) VALUES (?, ?)")
        .run("chunk-1", vectorToBlob([1, 0, 0]));
    } finally {
      legacyDb.close();
    }

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([
      expect.stringContaining(
        "Left Memory Core legacy memory index sidecar in place for agent main because legacy vector rows still require sqlite-vec: legacy vector table could not be validated",
      ),
    ]);
    expect(result.changes).toEqual([
      "Migrated Memory Core legacy memory index for agent main -> per-agent SQLite (1 source(s), 1 chunk(s), 1 cache row(s))",
    ]);
    await fs.access(legacyPath);
    await expect(fs.access(`${legacyPath}.migrated`)).rejects.toThrow();
  });

  it("keeps legacy vector sidecars retryable when sqlite-vec cannot load", async () => {
    await writeLegacyMemorySidecar(legacyPath, { vector: "vec0" });
    const config: RawLegacyDoctorConfig = {
      memory: {
        search: {
          store: {
            vector: {
              extensionPath: path.join(rootDir, "missing-sqlite-vec.so"),
            },
          },
        },
      },

      agents: mainAgents(),
    };

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams(config));

    expect(result.warnings).toEqual([
      expect.stringContaining(
        "Left Memory Core legacy memory index sidecar in place for agent main because legacy vector rows still require sqlite-vec",
      ),
    ]);
    expect(result.changes).toEqual([
      "Migrated Memory Core legacy memory index for agent main -> per-agent SQLite (1 source(s), 1 chunk(s), 1 cache row(s))",
    ]);
    expect(readMemoryRows(agentPath)).toEqual({
      sources: [{ path: "MEMORY.md", source: "memory", hash: "" }],
      chunks: [{ id: "chunk-1", text: "remember this" }],
      cache: [{ provider: "openai", hash: "chunk-hash" }],
    });
    const keywordRows = await searchMigratedKeywordRows(agentPath, "remember");
    expect(keywordRows.map((row) => row.id)).toEqual(["chunk-1"]);
    await fs.access(legacyPath);
    await expect(fs.access(`${legacyPath}.migrated`)).rejects.toThrow();
  });

  it("archives legacy vector sidecars when memory search is disabled", async () => {
    await writeLegacyMemorySidecar(legacyPath, { vector: "vec0" });
    const config: RawLegacyDoctorConfig = {
      memory: {
        search: {
          provider: "none",
          store: {
            vector: {
              extensionPath: path.join(rootDir, "missing-sqlite-vec.so"),
            },
          },
        },
      },

      agents: mainAgents(),
    };

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams(config));

    expect(result.warnings).toEqual([]);
    const keywordRows = await searchMigratedKeywordRows(agentPath, "remember");
    expect(keywordRows.map((row) => row.id)).toEqual(["chunk-1"]);
    await fs.access(`${legacyPath}.migrated`);
  });

  it("copies custom vector sidecars to a discoverable retry path when the canonical retry exists", async () => {
    legacyPath = path.join(rootDir, "custom-memory", "main.sqlite");
    const retryPath = path.join(stateDir, "memory", "main.sqlite");
    await writeLegacyMemorySidecar(legacyPath, { vector: "vec0" });
    await writeLegacyMemorySidecar(retryPath, { vector: "vec0" });
    const config: RawLegacyDoctorConfig = {
      memory: {
        search: {
          store: {
            path: legacyPath,
            vector: {
              extensionPath: path.join(rootDir, "missing-sqlite-vec.so"),
            },
          },
        },
      },

      agents: mainAgents(),
    };

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams(config));
    const retryEntries = await fs.readdir(path.join(stateDir, "memory"));
    const alternateRetry = retryEntries.find((entry) =>
      /^main\.retry-[a-f0-9]{12}\.sqlite$/.test(entry),
    );
    expect(alternateRetry).toBeDefined();
    const alternateRetryPath = path.join(stateDir, "memory", alternateRetry ?? "");
    const repairedConfig: RawLegacyDoctorConfig = {
      memory: {
        search: {
          store: {
            vector: {
              extensionPath: path.join(rootDir, "missing-sqlite-vec.so"),
            },
          },
        },
      },

      agents: mainAgents(),
    };
    const retryPreview = await legacyMemoryIndexMigration().detectLegacyState(
      migrationParams(repairedConfig),
    );

    expect(result.changes).toContain(
      `Copied Memory Core legacy memory index sidecar retry path -> ${alternateRetryPath}`,
    );
    expect(retryPreview?.preview).toEqual([
      `- Memory Core legacy memory index: ${alternateRetryPath} -> ${path.join(
        stateDir,
        "agents",
        "main",
        "agent",
        "openclaw-agent.sqlite",
      )}`,
    ]);
    await fs.access(legacyPath);
    await fs.access(alternateRetryPath);

    const retryEntriesBefore = (await fs.readdir(path.join(stateDir, "memory")))
      .filter((entry) => entry.startsWith("main.retry-"))
      .toSorted();
    const secondRun = await legacyMemoryIndexMigration().migrateLegacyState(
      migrationParams(repairedConfig),
    );
    const retryEntriesAfter = (await fs.readdir(path.join(stateDir, "memory")))
      .filter((entry) => entry.startsWith("main.retry-"))
      .toSorted();
    expect(secondRun.changes).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("Copied Memory Core legacy memory index sidecar retry path"),
      ]),
    );
    expect(retryEntriesAfter).toEqual(retryEntriesBefore.map((entry) => `${entry}.migrated`));
  });

  it("archives conflicting custom derived indexes without creating a retry copy", async () => {
    legacyPath = path.join(rootDir, "custom-memory", "main.sqlite");
    const retryPath = path.join(stateDir, "memory", "main.sqlite");
    await writeLegacyMemorySidecar(legacyPath);
    await createCanonicalMemoryIndex(agentPath, env, "conflicting");
    const config: RawLegacyDoctorConfig = {
      memory: {
        search: {
          store: {
            path: legacyPath,
          },
        },
      },

      agents: mainAgents(),
    };

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams(config));
    const repairedConfig: RawLegacyDoctorConfig = {
      agents: {
        list: [{ id: "main", workspace: workspaceDir }],
      },
    };
    const retryPreview = await legacyMemoryIndexMigration().detectLegacyState(
      migrationParams(repairedConfig),
    );

    expect(result.warnings).toEqual([]);
    expect(readMemoryRows(agentPath)).toEqual({
      sources: [{ path: "MEMORY.md", source: "memory", hash: "canonical-file-hash" }],
      chunks: [{ id: "canonical-chunk", text: "canonical memory remains authoritative" }],
      cache: [],
    });
    expect(retryPreview).toBeNull();
    await expect(fs.access(legacyPath)).rejects.toThrow();
    await expect(fs.access(retryPath)).rejects.toThrow();
    await fs.access(`${legacyPath}.migrated`);
  });

  it("copies custom sidecars to the retry path when canonical database setup fails", async () => {
    legacyPath = path.join(rootDir, "custom-memory", "main.sqlite");
    const retryPath = path.join(stateDir, "memory", "main.sqlite");
    await writeLegacyMemorySidecar(legacyPath);
    await fs.mkdir(agentPath, { recursive: true });
    const config: RawLegacyDoctorConfig = {
      memory: {
        search: {
          store: {
            path: legacyPath,
          },
        },
      },

      agents: mainAgents(),
    };

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams(config));
    const repairedConfig: RawLegacyDoctorConfig = {
      agents: {
        list: [{ id: "main", workspace: workspaceDir }],
      },
    };
    const retryPreview = await legacyMemoryIndexMigration().detectLegacyState(
      migrationParams(repairedConfig),
    );

    expect(result.changes).toEqual([
      `Copied Memory Core legacy memory index sidecar retry path -> ${retryPath}`,
    ]);
    expect(result.warnings).toEqual([
      expect.stringContaining(
        "Skipped Memory Core legacy memory index import for agent main because the sidecar could not be imported:",
      ),
    ]);
    expect(retryPreview?.preview).toEqual([
      `- Memory Core legacy memory index: ${retryPath} -> ${agentPath}`,
    ]);
    await fs.access(legacyPath);
    await fs.access(retryPath);
  });

  it("keeps canonical metadata and archives a conflicting derived legacy index", async () => {
    await writeLegacyMemorySidecar(legacyPath);
    await createCanonicalMemoryIndex(agentPath, env, "unrelated", { vectorDims: 4 });

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([]);
    expect(readMemoryRows(agentPath).chunks).toEqual([
      { id: "canonical-other-chunk", text: "canonical unrelated memory" },
    ]);
    await expect(fs.access(legacyPath)).rejects.toThrow();
    await fs.access(`${legacyPath}.migrated`);

    const secondRun = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());
    expect(secondRun).toEqual({ changes: [], warnings: [] });
  });

  it("keeps canonical chunks and archives a conflicting derived legacy index", async () => {
    await writeLegacyMemorySidecar(legacyPath);
    await createCanonicalMemoryIndex(agentPath, env, "matching", { ftsText: "remember this" });
    const canonicalDb = new DatabaseSync(agentPath);
    try {
      canonicalDb
        .prepare("UPDATE memory_index_chunks SET text = ? WHERE id = ?")
        .run("canonical memory remains authoritative", "chunk-1");
    } finally {
      canonicalDb.close();
    }

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([]);
    expect(readMemoryRows(agentPath)).toEqual({
      sources: [{ path: "MEMORY.md", source: "memory", hash: "file-hash" }],
      chunks: [{ id: "chunk-1", text: "canonical memory remains authoritative" }],
      cache: [],
    });
    await expect(fs.access(legacyPath)).rejects.toThrow();
    await fs.access(`${legacyPath}.migrated`);
  });

  it("keeps canonical cache collisions while importing remaining legacy rows", async () => {
    await writeLegacyMemorySidecar(legacyPath);
    const legacyDb = new DatabaseSync(legacyPath);
    try {
      legacyDb
        .prepare("INSERT INTO embedding_cache VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("cohere", "embed-model", "key", "other-hash", "[1,1,0]", 3, 41);
    } finally {
      legacyDb.close();
    }
    await createCanonicalMemoryIndex(agentPath, env, "unrelated");
    const canonicalDb = new DatabaseSync(agentPath);
    try {
      canonicalDb
        .prepare(
          "INSERT INTO memory_embedding_cache (provider, model, provider_key, hash, embedding, dims, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("openai", "embed-model", "key", "chunk-hash", encodeMemoryEmbedding([0, 1, 0]), 3, 99);
    } finally {
      canonicalDb.close();
    }

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([]);
    expect(readMemoryRows(agentPath)).toEqual({
      sources: [
        { path: "MEMORY.md", source: "memory", hash: "" },
        { path: "OTHER.md", source: "memory", hash: "canonical-other-file-hash" },
      ],
      chunks: [
        { id: "canonical-other-chunk", text: "canonical unrelated memory" },
        { id: "chunk-1", text: "remember this" },
      ],
      cache: [
        { provider: "cohere", hash: "other-hash" },
        { provider: "openai", hash: "chunk-hash" },
      ],
    });
    expect(readMemoryCacheRows(agentPath)).toEqual([
      {
        provider: "cohere",
        model: "embed-model",
        provider_key: "key",
        hash: "other-hash",
        embedding: encodeMemoryEmbedding([1, 1, 0]),
        dims: 3,
        updated_at: 41,
      },
      {
        provider: "openai",
        model: "embed-model",
        provider_key: "key",
        hash: "chunk-hash",
        embedding: encodeMemoryEmbedding([0, 1, 0]),
        dims: 3,
        updated_at: 99,
      },
    ]);
    await expect(fs.access(legacyPath)).rejects.toThrow();
    await fs.access(`${legacyPath}.migrated`);

    const secondRun = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());
    expect(secondRun).toEqual({ changes: [], warnings: [] });
  });

  it.each([
    {
      reason: "declared dimensions differ",
      canonicalEmbedding: encodeMemoryEmbedding([0, 1, 0]),
      canonicalDims: 4,
    },
    {
      reason: "embedding lengths differ",
      canonicalEmbedding: encodeMemoryEmbedding([0, 1, 0, 0]),
      canonicalDims: 3,
    },
    {
      reason: "the canonical embedding is malformed",
      canonicalEmbedding: new Uint8Array([1, 2, 3]),
      canonicalDims: 3,
    },
    {
      reason: "the legacy embedding is malformed",
      canonicalEmbedding: encodeMemoryEmbedding([0, 1, 0]),
      canonicalDims: 3,
      legacyEmbedding: "not-json",
    },
    {
      reason: "both declared dimensions are missing",
      canonicalEmbedding: encodeMemoryEmbedding([0, 1, 0]),
      canonicalDims: null,
      legacyDims: null,
    },
  ])(
    "keeps canonical cache rows when a legacy collision has $reason",
    async ({ canonicalEmbedding, canonicalDims, legacyEmbedding, legacyDims }) => {
      await writeLegacyMemorySidecar(legacyPath, {
        cacheEmbedding: legacyEmbedding,
        cacheDims: legacyDims,
      });
      await createCanonicalMemoryIndex(agentPath, env, "unrelated");
      const canonicalDb = new DatabaseSync(agentPath);
      try {
        canonicalDb
          .prepare(
            "INSERT INTO memory_embedding_cache (provider, model, provider_key, hash, embedding, dims, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run("openai", "embed-model", "key", "chunk-hash", canonicalEmbedding, canonicalDims, 99);
      } finally {
        canonicalDb.close();
      }

      const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

      expect(result.warnings).toEqual([]);
      expect(result.changes).toEqual([
        "Resolved Memory Core legacy memory index conflict for agent main by keeping canonical per-agent SQLite rows",
        expect.stringContaining("Archived Memory Core legacy memory index sidecar"),
      ]);
      expect(readMemoryRows(agentPath)).toEqual({
        sources: [{ path: "OTHER.md", source: "memory", hash: "canonical-other-file-hash" }],
        chunks: [{ id: "canonical-other-chunk", text: "canonical unrelated memory" }],
        cache: [{ provider: "openai", hash: "chunk-hash" }],
      });
      expect(readMemoryCacheRows(agentPath)).toEqual([
        {
          provider: "openai",
          model: "embed-model",
          provider_key: "key",
          hash: "chunk-hash",
          embedding: canonicalEmbedding,
          dims: canonicalDims,
          updated_at: 99,
        },
      ]);
      await expect(fs.access(legacyPath)).rejects.toThrow();
      await fs.access(`${legacyPath}.migrated`);
    },
  );

  it("leaves legacy vector sidecars in place when vector dimensions conflict", async () => {
    await writeLegacyMemorySidecar(legacyPath, { vector: true });
    await createMismatchedCanonicalVectorIndex(agentPath, env);

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([
      expect.stringContaining(
        "Skipped Memory Core legacy memory index import for agent main because legacy rows could not be imported: Error: legacy memory chunks_vec dimensions 3 do not match canonical memory chunks_vec dimensions 4",
      ),
    ]);
    expect(result.changes).toEqual([]);
    await fs.access(legacyPath);
    await expect(fs.access(`${legacyPath}.migrated`)).rejects.toThrow();
  });

  it("keeps canonical vector rows and archives a conflicting derived legacy index", async () => {
    await writeLegacyMemorySidecar(legacyPath, { vector: true });
    await createConflictingCanonicalVectorIndex(agentPath, env);

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Resolved Memory Core legacy memory index conflict for agent main by keeping canonical per-agent SQLite rows",
      expect.stringContaining("Archived Memory Core legacy memory index sidecar"),
    ]);
    await expect(fs.access(legacyPath)).rejects.toThrow();
    await fs.access(`${legacyPath}.migrated`);
  });

  it("leaves legacy vector sidecars in place when vector rows have no chunk", async () => {
    await writeLegacyMemorySidecar(legacyPath, { vector: true });
    const legacyDb = new DatabaseSync(legacyPath);
    try {
      legacyDb.exec("DELETE FROM chunks");
    } finally {
      legacyDb.close();
    }

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([
      expect.stringContaining(
        "Skipped Memory Core legacy memory index import for agent main because legacy rows could not be imported: Error: legacy memory chunks_vec rows reference missing chunks",
      ),
    ]);
    expect(result.changes).toEqual([]);
    await fs.access(legacyPath);
    await expect(fs.access(`${legacyPath}.migrated`)).rejects.toThrow();
  });

  it("rebuilds stale FTS from canonical chunks while importing legacy rows", async () => {
    await writeLegacyMemorySidecar(legacyPath);
    const legacyDb = new DatabaseSync(legacyPath);
    try {
      legacyDb.exec(`
        INSERT INTO files VALUES ('SECOND.md', 'memory', 'second-file-hash', 11, 21);
        INSERT INTO chunks VALUES (
          'chunk-2', 'SECOND.md', 'memory', 1, 1, 'second-chunk-hash', 'embed-model',
          'second legacy memory', '[0,1,0]', 31
        );
      `);
    } finally {
      legacyDb.close();
    }
    await createCanonicalMemoryIndex(agentPath, env, "matching", { ftsText: "stale text" });

    const result = await legacyMemoryIndexMigration().migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([]);
    expect(await searchMigratedKeywordRows(agentPath, "stale")).toEqual([]);
    expect((await searchMigratedKeywordRows(agentPath, "remember")).map((row) => row.id)).toEqual([
      "chunk-1",
    ]);
    expect((await searchMigratedKeywordRows(agentPath, "second")).map((row) => row.id)).toEqual([
      "chunk-2",
    ]);
    expect(readMemoryRows(agentPath)).toEqual({
      sources: [
        { path: "MEMORY.md", source: "memory", hash: "file-hash" },
        { path: "SECOND.md", source: "memory", hash: "" },
      ],
      chunks: [
        { id: "chunk-1", text: "remember this" },
        { id: "chunk-2", text: "second legacy memory" },
      ],
      cache: [{ provider: "openai", hash: "chunk-hash" }],
    });
    await expect(fs.access(legacyPath)).rejects.toThrow();
    await fs.access(`${legacyPath}.migrated`);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
