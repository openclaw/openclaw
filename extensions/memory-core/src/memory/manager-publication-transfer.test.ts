import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import {
  encodeMemoryEmbedding,
  ensureMemoryIndexSchema,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import * as sqliteWorkerRuntime from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureMemorySessionTombstones,
  recordMemorySessionTombstonesInDatabase,
} from "../memory-session-tombstones.js";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import { readMemoryDatabaseRevision } from "./manager-db-kernel.js";
import {
  memoryEmbeddingCacheBatches,
  memoryPublicationBatches,
  memoryPublicationGroup,
  memoryPublicationInline,
  releaseMemoryPublication,
} from "./manager-publication-transfer.js";
import {
  bindSqliteWorkerBackend,
  createSqliteWorkerBackend,
  openExistingSqliteWorkerBackend,
} from "./manager-publication.worker.js";
import { readMemoryShadowIdentity } from "./manager-shadow-task.js";
import type {
  MemorySourceIndexReplacement,
  MemorySourceIndexRow,
} from "./manager-source-index-kernel.js";
import { memoryChunkRowId } from "./manager-source-index-kernel.js";

const owners: MemoryIndexDatabase[] = [];
const fixtureWriters = new Map<MemoryIndexDatabase, DatabaseSync>();
const backends: Awaited<ReturnType<typeof openExistingSqliteWorkerBackend>>[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const backend of backends.splice(0)) {
      await backend.close();
    }
    for (const writer of fixtureWriters.values()) {
      writer.close();
    }
    fixtureWriters.clear();
    for (const owner of owners.splice(0)) {
      await owner.closeShadow();
    }
    cleanup();
  }),
);

async function createOwner() {
  const owner = await MemoryIndexDatabase.openShadow(
    path.join(tempDirs.make("memory-publication-transfer-"), "index # é.sqlite"),
    false,
  );
  owners.push(owner);
  await owner.admitSchema({ cacheEnabled: false, ftsEnabled: true });
  expect(owner.fts.available).toBe(true);
  return owner;
}

function fixtureWriter(owner: MemoryIndexDatabase): DatabaseSync {
  let writer = fixtureWriters.get(owner);
  if (!writer) {
    writer = sqliteRuntime.openNodeSqliteDatabase(owner.db.location()!);
    writer.exec("PRAGMA busy_timeout = 5000");
    fixtureWriters.set(owner, writer);
  }
  return writer;
}

function publicationInput(owner: MemoryIndexDatabase) {
  const filename = owner.db.location()!;
  const writer = fixtureWriter(owner);
  const readPragma = (name: string) => {
    const row = writer.prepare(`PRAGMA ${name}`).get();
    return Number(row?.[name] ?? row?.timeout);
  };
  return {
    fileIdentity: readMemoryShadowIdentity(filename),
    pragmas: {
      busy_timeout: readPragma("busy_timeout"),
      foreign_keys: readPragma("foreign_keys"),
    },
  };
}

async function createBackend(
  owner: MemoryIndexDatabase,
  admit?: (stage: "transaction" | "commit") => void,
) {
  const filename = owner.db.location()!;
  const input = publicationInput(owner);
  const writer = fixtureWriter(owner);
  const backend = admit
    ? bindSqliteWorkerBackend(input, { databasePath: filename, database: writer, admit })
    : await openExistingSqliteWorkerBackend(input, { databasePath: filename });
  backends.push(backend);
  return backend;
}

const queryRows = (db: DatabaseSync, sql: string) => db.prepare(sql).all();
const expectRows = (db: DatabaseSync, sql: string, rows: unknown[]) =>
  expect(queryRows(db, sql)).toEqual(rows);
const expectValues = (db: DatabaseSync, sql: string, rows: unknown[][]) =>
  expect(queryRows(db, sql).map((row) => Object.values(row))).toEqual(rows);
const sourceHash = (db: DatabaseSync) => db.prepare("SELECT hash FROM memory_index_sources").get();
const publish = (owner: MemoryIndexDatabase, input: MemorySourceIndexReplacement) =>
  owner.replaceSource(
    input,
    () => undefined,
    async () => true,
  );

const disabled = { enabled: false, available: false };
const enabled = { enabled: true, available: true };
function stageSource(
  backend: Awaited<ReturnType<typeof createBackend>>,
  input: MemorySourceIndexReplacement,
) {
  const { chunks: _chunks, embeddings: _embeddings, ...header } = input;
  backend.execute({ type: "stage.start", input: { header } });
  for (const fragments of memoryPublicationBatches(input)) {
    backend.execute({ type: "stage.append", input: { fragments } });
  }
}

function forget(db: DatabaseSync, sessionId: string) {
  recordMemorySessionTombstonesInDatabase(db, {
    agentId: "main",
    sessionIds: [sessionId],
    createdAt: 1,
  });
}

function replacement(text = "Violetmarker transfer text"): MemorySourceIndexReplacement {
  return {
    source: "memory",
    entry: {
      path: "memory/é.md",
      hash: "source-hash",
      mtimeMs: 100.25,
      size: Buffer.byteLength(text),
    },
    model: "transfer-model",
    now: 101,
    vectorReady: false,
    embeddings: [[0.125, -0.5, 1]],
    chunks: [
      {
        startLine: 1,
        endLine: 3,
        text,
        hash: "chunk-hash",
        importance: 7,
        triggers: '["漢字","🧠"]',
        projectKey: "project/é",
        provenance: {
          originClass: "owner",
          sessionKind: "interactive",
          observedAt: 90,
          supersedesKey: "old/🔑",
        },
      },
    ],
  };
}

describe("bounded memory publication transfer", () => {
  afterEach(() => vi.restoreAllMocks());

  it("configures a fresh shadow once and retains only transaction restoration settings", async () => {
    const databasePath = path.join(tempDirs.make("memory-publication-policy-"), "shadow.sqlite");
    const observed = observeHostDataSql();
    try {
      const backend = await createSqliteWorkerBackend({ allowExtension: false }, { databasePath });
      backends.push(backend);
      expect(backend.execute({ type: "connection.inspect", input: undefined })).toEqual({
        fileIdentity: readMemoryShadowIdentity(databasePath),
        pragmas: { busy_timeout: 5000, foreign_keys: expect.any(Number) },
      });
      expect(
        observed.queries.filter((sql) => /^PRAGMA journal_size_limit\s*=/i.test(sql)),
      ).toHaveLength(1);
      expect(
        observed.queries.filter((sql) =>
          /^PRAGMA (synchronous|journal_size_limit|checkpoint_fullfsync)\s*;?$/i.test(sql),
        ),
      ).toEqual([]);
    } finally {
      observed.restore();
    }
  });

  it("avoids unused connection work for scalar publications", () => {
    const filename = path.join(tempDirs.make("memory-publication-input-"), "index.sqlite");
    const db = new DatabaseSync(filename);
    try {
      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
      const sql = vi.spyOn(db, "exec");
      const reads = vi.spyOn(db, "prepare");
      const bind = () =>
        bindSqliteWorkerBackend(
          { kind: "agent" },
          { databasePath: filename, database: db, admit: () => undefined },
        );
      const scalar = bind();
      expect(
        scalar.execute({
          type: "index.writeMetadata",
          input: { provider: "none", model: "fts-only", chunkTokens: 400, chunkOverlap: 80 },
        }),
      ).toMatchObject({ ok: true });
      expect(
        reads.mock.calls.filter(([statement]) =>
          /^PRAGMA (synchronous|journal_size_limit|checkpoint_fullfsync)$/u.test(statement),
        ),
      ).toEqual([]);
      expect(scalar.execute({ type: "connection.inspect", input: undefined })).toEqual({
        fileIdentity: readMemoryShadowIdentity(filename),
        pragmas: {
          busy_timeout: expect.any(Number),
          foreign_keys: expect.any(Number),
        },
      });
      scalar.close();
      expect(
        sql.mock.calls.filter(([statement]) => /memory_publication_input/u.test(statement)),
      ).toEqual([]);
      const staged = bind();
      stageSource(staged, replacement("staged text survives scalar cleanup"));
      expect(
        staged.execute({
          type: "source.replace",
          input: { state: { vector: disabled, fts: disabled } },
        }),
      ).toMatchObject({ ok: true });
      staged.close();
      expectRows(db, "SELECT text FROM memory_index_chunks", [
        { text: "staged text survives scalar cleanup" },
      ]);
      expectRows(
        db,
        "SELECT name FROM sqlite_temp_master WHERE name = 'memory_publication_input'",
        [],
      );
    } finally {
      db.close();
    }
  });

  it("reads current source rows without restaging scratch or inspecting canonical connection policy", async () => {
    const owner = await createOwner();
    const db = fixtureWriter(owner);
    db.exec(`INSERT INTO memory_index_sources(path, source, hash, mtime, size)
      VALUES ('memory/current', 'memory', 'old', 1, 1)`);
    const input = publicationInput(owner);
    const sql = observeHostDataSql();
    try {
      for (const hash of ["old", "changed"]) {
        const backend = bindSqliteWorkerBackend(input, {
          databasePath: db.location()!,
          database: db,
          admit: () => undefined,
        });
        try {
          expect(
            backend.execute({
              type: "source.hash",
              input: { source: "memory", path: "memory/current" },
            }),
          ).toBe(hash);
        } finally {
          backend.close();
        }
        db.exec("UPDATE memory_index_sources SET hash = 'changed'");
      }
      expect(
        sql.queries.filter((query) =>
          /PRAGMA\s+(busy_timeout|synchronous|foreign_keys|journal_size_limit|checkpoint_fullfsync)|memory_publication_input/iu.test(
            query,
          ),
        ),
      ).toEqual([]);
    } finally {
      sql.restore();
    }
  });

  it("rolls back a refused inline cache commit and preserves tombstones", async () => {
    const owner = await createOwner();
    const db = fixtureWriter(owner);
    ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: true });
    ensureMemorySessionTombstones(db);
    forget(db, "forgotten");
    let refused = true;
    const backend = await createBackend(owner, (stage) => {
      if (stage === "commit" && refused) {
        throw new Error("inline commit refused");
      }
    });
    const command = {
      type: "cache.write.inline" as const,
      input: {
        header: {
          agentId: "main",
          provider: { id: "provider", model: "model" },
          providerKey: "key",
          maxEntries: 1,
        },
        entries: [
          { hash: "current", embedding: [-0, 0.25] },
          { hash: "forgotten", embedding: [9], sessionId: "forgotten" },
        ],
      },
    };
    const sql = observeHostDataSql();
    try {
      expect(backend.execute(command)).toMatchObject({
        ok: false,
        entered: true,
        committed: false,
        error: { message: "inline commit refused" },
      });
      expectRows(db, "SELECT hash FROM memory_embedding_cache", []);
      refused = false;
      expect(backend.execute(command)).toMatchObject({ ok: true, value: true });
      expectRows(db, "SELECT hash, embedding FROM memory_embedding_cache", [
        { hash: "current", embedding: encodeMemoryEmbedding([-0, 0.25]) },
      ]);
      expect(sql.queries.filter((query) => query.includes("memory_publication_input"))).toEqual([]);
    } finally {
      sql.restore();
    }
  });

  it.each(["success", "stale", "begin", "write", "transaction", "commit"] as const)(
    "settles an atomic source refresh through %s",
    async (fault) => {
      const owner = await createOwner();
      const db = fixtureWriter(owner);
      db.exec(`INSERT INTO memory_index_sources(path, source, hash, mtime, size)
        VALUES ('sessions/current', 'sessions', 'old', 1, 1)`);
      const revision = readMemoryDatabaseRevision(db);
      const backend = await createBackend(owner, (stage) => {
        expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
        if (fault === stage) {
          throw new Error(`refused ${stage}`);
        }
      });
      if (fault === "write") {
        db.exec(`CREATE TRIGGER refuse_refresh BEFORE UPDATE ON memory_index_sources
          BEGIN SELECT RAISE(ABORT, 'refused write'); END`);
      }
      const locker =
        fault === "begin" ? sqliteRuntime.openNodeSqliteDatabase(db.location()!) : undefined;
      locker?.exec("BEGIN IMMEDIATE");
      try {
        const outcome = backend.execute({
          type: "source.refresh",
          input: {
            path: "sessions/current",
            hash: "new",
            mtime: 2,
            size: 2,
            expectedHash: fault === "stale" ? "superseded" : "old",
          },
        });
        expect(outcome).toMatchObject(
          fault === "success" || fault === "stale"
            ? { ok: true, value: fault === "success" }
            : { ok: false, entered: fault !== "begin", committed: false },
        );
        expect(db.isTransaction).toBe(false);
        expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
        expect(sourceHash(db)).toEqual({ hash: fault === "success" ? "new" : "old" });
        expect(readMemoryDatabaseRevision(db)).toBe(revision + (fault === "success" ? 1 : 0));
      } finally {
        locker?.exec("ROLLBACK");
        locker?.close();
      }
    },
  );

  it("opens keyword publication when SQLite extension loading is unavailable", async () => {
    const owner = await createOwner();
    vi.spyOn(sqliteWorkerRuntime, "supportsNodeSqliteExtensionLoading").mockReturnValue(false);
    const open = sqliteWorkerRuntime.openNodeSqliteDatabase;
    vi.spyOn(sqliteWorkerRuntime, "openNodeSqliteDatabase").mockImplementation(
      (location, options) => {
        if (options?.allowExtension) {
          throw new Error("SQLite extension loading is unavailable");
        }
        return open(location, options);
      },
    );
    const backend = await createBackend(owner);
    stageSource(backend, replacement());
    backend.execute({ type: "stage.discard", input: undefined });
    expect(owner.db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("publishes and deletes keyword data with an unavailable configured extension", async () => {
    const owner = await createOwner();
    owner.vector.enabled = true;
    owner.vector.available = false;
    owner.vector.extensionPath = path.join(path.dirname(owner.db.location()!), "missing-vec");
    const input = replacement();
    const assertCurrent = () => undefined;
    await owner.replaceSource(input, assertCurrent, async () => true);
    const matches = () =>
      owner.db
        .prepare(
          "SELECT path FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH 'Violetmarker'",
        )
        .all();
    expect(matches()).toEqual([{ path: input.entry.path }]);
    expect(
      await owner.deleteSource(
        { path: input.entry.path, source: "memory", expectedHash: input.entry.hash },
        assertCurrent,
      ),
    ).toBe(true);
    expect(matches()).toEqual([]);

    const shadow = await createOwner();
    await shadow.replaceSource(input, assertCurrent, async () => true);
    await shadow.closePublicationWorker();
    const sourcePath = shadow.db.location()!;
    await owner.publishShadow(
      {
        sourcePath,
        sourceIdentity: readMemoryShadowIdentity(sourcePath),
        metaKey: "test-meta",
        expectedRevision: readMemoryDatabaseRevision(owner.db),
        sourceSchema: shadow.searchSchema,
        vectorIndexComplete: false,
        extensionPath: owner.vector.extensionPath,
      },
      assertCurrent,
    );
    expect(matches()).toEqual([{ path: input.entry.path }]);
    expect(owner.db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("preserves extension load failures when vector publication requires the extension", async () => {
    const owner = await createOwner();
    owner.vector.enabled = true;
    owner.vector.available = true;
    owner.vector.extensionPath = path.join(path.dirname(owner.db.location()!), "missing-vec");
    await expect(
      owner.replaceSource(
        replacement(),
        () => undefined,
        async () => true,
      ),
    ).rejects.toThrow();
    expect(owner.db.prepare("SELECT * FROM memory_index_sources").all()).toEqual([]);
  });

  it.each([false, true])(
    "preserves the failed publication outcome (close failure: %s)",
    async (failClose) => {
      const owner = await createOwner();
      await owner.closePublicationWorker();
      const original = Object.assign(new Error("publication result unavailable"), {
        code: "outcome-unknown",
      });
      const cleanup = new Error("publication close failed");
      const commands: string[] = [];
      let closed = false;
      const run = sqliteRuntime.runSqliteWorkerStoreWrite;
      vi.spyOn(sqliteRuntime, "runSqliteWorkerStoreWrite").mockImplementation(
        (store, operation, ...options) =>
          run(
            store,
            (scope) =>
              operation({
                execute: async (command) => {
                  commands.push(command.type);
                  if (command.type === "source.replace.inline") {
                    throw original;
                  }
                  if (command.type === "stage.discard") {
                    throw new Error("retired publication scope");
                  }
                  return scope.execute(command);
                },
              }),
            ...options,
          ),
      );
      const open = sqliteRuntime.openSqliteWorkerStore;
      vi.spyOn(sqliteRuntime, "openSqliteWorkerStore").mockImplementation(async (options) => {
        const store = await open(options);
        if (store) {
          const close = store.close.bind(store);
          vi.spyOn(store, "close").mockImplementationOnce(async () => {
            await close();
            closed = true;
            if (failClose) {
              throw cleanup;
            }
          });
        }
        return store;
      });
      const result = publish(owner, replacement());
      if (failClose) {
        const failure: unknown = await result.catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        assert.ok(failure instanceof AggregateError);
        expect(failure.cause).toBe(original);
        expect(failure.errors).toHaveLength(2);
        expect(failure.errors[0]).toBe(original);
        expect(failure.errors[1]).toBe(cleanup);
        expect(String(failure)).toContain(original.message);
        expect(String(failure)).toContain(cleanup.message);
        await owner.closePublicationWorker();
      } else {
        await expect(result).rejects.toBe(original);
      }
      expect(closed).toBe(true);
      expect(commands).toEqual(["source.replace.inline"]);
      expectRows(owner.db, "SELECT * FROM memory_index_sources", []);
    },
  );

  it("discards declined preparation and reuses its healthy publication owner", async () => {
    const open = vi.spyOn(sqliteRuntime, "openSqliteWorkerStore");
    const owner = await createOwner();
    await expect(
      owner.replaceSource(
        replacement("declined"),
        () => undefined,
        async () => false,
      ),
    ).resolves.toBeUndefined();
    expect(owner.db.prepare("SELECT * FROM memory_index_sources").all()).toEqual([]);
    await owner.replaceSource(
      replacement("accepted"),
      () => undefined,
      async () => true,
    );
    expect(open).toHaveBeenCalledTimes(1);
    expect(owner.db.prepare("SELECT text FROM memory_index_chunks").all()).toEqual([
      { text: "accepted" },
    ]);
  });

  it("roundtrips an oversized Unicode record and its metadata through the native publication owner", async () => {
    const owner = await createOwner();
    // Non-BMP text spans many fragment boundaries, including pairs whose halves
    // could otherwise be separately converted to UTF-8 by SQLite TEXT bindings.
    const text = "a" + "😀".repeat(160_000) + '\n漢字 e\u0301 "quoted" \\ tail Violetmarker';
    const input = replacement(text);
    const vector = Array.from({ length: 1_025 }, (_, index) => index / 7);
    vector.splice(510, 4, -0, Number.MIN_VALUE, Number.MAX_VALUE, 1 + Number.EPSILON);
    input.embeddings = [vector];
    const batches = [...memoryPublicationBatches(input)];
    expect(memoryPublicationInline(input)).toBeUndefined();
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(serialize(batch).byteLength).toBeLessThanOrEqual(512 * 1024);
    }
    await publish(owner, input);
    expectValues(
      owner.db,
      "SELECT path, source, start_line, end_line, hash, model, text, embedding, updated_at FROM memory_index_chunks",
      [
        [
          input.entry.path,
          "memory",
          1,
          3,
          "chunk-hash",
          "transfer-model",
          text,
          encodeMemoryEmbedding(vector.map((value) => (Object.is(value, -0) ? 0 : value))),
          101,
        ],
      ],
    );
    expectValues(owner.db, "SELECT path, source, hash, mtime, size FROM memory_index_sources", [
      [input.entry.path, "memory", "source-hash", 100.25, Buffer.byteLength(text)],
    ]);
    expectValues(
      owner.db,
      "SELECT importance, triggers, project_key FROM memory_index_chunk_recall_metadata",
      [[7, '["漢字","🧠"]', "project/é"]],
    );
    expectValues(
      owner.db,
      "SELECT origin_class, session_kind, observed_at, supersedes_key FROM memory_index_chunk_provenance",
      [["owner", "interactive", 90, "old/🔑"]],
    );
    expectRows(
      owner.db,
      "SELECT path FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH 'Violetmarker'",
      [{ path: input.entry.path }],
    );
  });

  it("keeps inline source replacement atomic and observes a later in-process forget", async () => {
    const owner = await createOwner();
    const db = fixtureWriter(owner);
    ensureMemorySessionTombstones(db);
    const input: MemorySourceIndexReplacement = {
      ...replacement(),
      source: "sessions",
      agentId: "main",
      sessionId: "inline-session",
    };
    const inline = memoryPublicationInline(input);
    assert.ok(inline);
    let refuseCommit = false;
    const backend = await createBackend(owner, (stage) => {
      if (stage === "commit" && refuseCommit) {
        throw new Error("refused inline source commit");
      }
    });
    const command = {
      type: "source.replace.inline" as const,
      input: {
        ...inline,
        state: { vector: disabled, fts: enabled },
      },
    };
    expect(backend.execute(command)).toMatchObject({ ok: true });
    refuseCommit = true;
    expect(
      backend.execute({
        ...command,
        input: {
          ...command.input,
          header: { ...inline.header, entry: { ...inline.header.entry, hash: "replacement" } },
        },
      }),
    ).toMatchObject({ ok: false, entered: true, committed: false });
    expect(sourceHash(db)).toEqual({ hash: "source-hash" });
    refuseCommit = false;
    forget(db, "inline-session");
    expect(backend.execute(command)).toMatchObject({
      ok: false,
      committed: false,
      error: { message: expect.stringContaining("forgotten") },
    });
    expect(sourceHash(db)).toEqual({ hash: "source-hash" });
  });

  it("keeps concurrent large source transfers separate through their publication scopes", async () => {
    const owner = await createOwner();
    const inputs = ["first", "second"].map((name) => {
      const input = replacement(`${name} ${"x".repeat(350_000)}`);
      input.entry = { ...input.entry, path: `memory/${name}.md`, hash: name };
      input.chunks = input.chunks.map((chunk) => ({ ...chunk, hash: name }));
      expect(memoryPublicationInline(input)).toBeUndefined();
      return input;
    });

    await Promise.all(inputs.map((input) => publish(owner, input)));

    expect(queryRows(owner.db, "SELECT path, text FROM memory_index_chunks ORDER BY path")).toEqual(
      inputs.map((input) => ({ path: input.entry.path, text: input.chunks[0]!.text })),
    );
  });

  it.each(["sessions", "memory"] as const)(
    "publishes planned removals and keeps unchanged %s rows searchable",
    async (source) => {
      const owner = await createOwner();
      ensureMemorySessionTombstones(fixtureWriter(owner));
      const [template] = replacement().chunks;
      assert.ok(template);
      const turn = (line: number) => ({
        ...template,
        startLine: line,
        endLine: line,
        text: `turn ${line} Violetmarker`,
        hash: `turn-${line}`,
      });
      const session = (
        hash: string,
        chunks: ReturnType<typeof turn>[],
        retained: ReturnType<typeof turn>[] = [],
      ): MemorySourceIndexReplacement => ({
        ...replacement(),
        ...(source === "sessions"
          ? { source, agentId: "main", sessionId: "delta-session" }
          : { source }),
        entry: {
          path: source === "sessions" ? "sessions/main/delta.jsonl" : "memory/delta.md",
          hash,
          mtimeMs: 1,
          size: 1,
        },
        embeddings: chunks.map(() => []),
        chunks,
        retained,
      });
      const rows = () =>
        queryRows(
          owner.db,
          "SELECT chunk_rowid, start_line, text FROM memory_index_chunks ORDER BY start_line",
        );

      await publish(owner, session("v1", [turn(1), turn(2)]));
      const [first] = rows();
      const delta = session("v2", [turn(3)], [turn(1)]);
      delta.removedIds = [memoryChunkRowId(source, delta.entry.path, turn(2), delta.model)];
      await expect(publish(owner, delta)).resolves.toBe(true);
      expect(rows()).toEqual([
        first,
        expect.objectContaining({ start_line: 3, text: "turn 3 Violetmarker" }),
      ]);
      expect(
        owner.db.prepare("SELECT COUNT(*) AS count FROM memory_index_chunks_fts").get(),
      ).toEqual({ count: 2 });

      expectRows(
        owner.db,
        "SELECT start_line FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH 'Violetmarker' ORDER BY start_line",
        [{ start_line: 1 }, { start_line: 3 }],
      );
    },
  );

  it.each([8, 4 * 1024 * 1024 + 1])(
    "roundtrips %i-coordinate cache vectors with tombstone and capacity limits",
    async (coordinates) => {
      const owner = await createOwner();
      const writer = fixtureWriter(owner);
      ensureMemoryIndexSchema({ db: writer, cacheEnabled: true, ftsEnabled: true });
      ensureMemorySessionTombstones(fixtureWriter(owner));
      const header = {
        agentId: "main",
        provider: { id: "transfer-provider", model: "transfer-model" },
        providerKey: "transfer-key",
        maxEntries: 2,
      };
      const insert = writer.prepare(`INSERT INTO memory_embedding_cache
      (provider, model, provider_key, hash, embedding, dims, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, 1)`);
      for (const hash of ["old-a", "old-b"]) {
        insert.run(
          header.provider.id,
          header.provider.model,
          header.providerKey,
          hash,
          encodeMemoryEmbedding([1]),
        );
      }
      const readRows = () =>
        queryRows(owner.db, "SELECT * FROM memory_embedding_cache ORDER BY hash");
      const assertCurrent = () => undefined;
      recordMemorySessionTombstonesInDatabase(writer, {
        agentId: "main",
        sessionIds: ["forgotten"],
        createdAt: 1,
      });
      const vector = Array.from({ length: coordinates }, () => 0.125);
      vector.splice(0, 4, -0, Number.MIN_VALUE, Number.MAX_VALUE, 1 + Number.EPSILON);
      const entries = [
        { hash: "large", embedding: vector },
        { hash: "survivor", embedding: [0.25, -0] },
        { hash: "forgotten", embedding: [9], sessionId: "forgotten" },
      ];
      if (coordinates > 8) {
        expect(serialize(entries).byteLength).toBeGreaterThan(32 * 1024 * 1024);
      }
      let batches = 0;
      for (const batch of memoryEmbeddingCacheBatches(entries)) {
        batches++;
        expect(serialize(batch).byteLength).toBeLessThanOrEqual(512 * 1024);
      }
      expect(batches > 1).toBe(coordinates > 8);
      await expect(
        owner.mutateEmbeddingCache({ kind: "upsert", header, entries }, assertCurrent, () => true),
      ).resolves.toBe(true);
      const rows = readRows();
      expect(rows.map((row) => row.hash)).toEqual(["large", "survivor"]);
      expect(rows.map((row) => [row.provider, row.model, row.provider_key, row.dims])).toEqual([
        [header.provider.id, header.provider.model, header.providerKey, vector.length],
        [header.provider.id, header.provider.model, header.providerKey, 2],
      ]);
      const bytes = rows[0]?.embedding;
      if (!(bytes instanceof Uint8Array)) {
        throw new Error("Expected the native cache BLOB");
      }
      expect(Buffer.from(bytes).equals(encodeMemoryEmbedding(vector))).toBe(true);
      expect(
        Object.is(
          new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0, true),
          -0,
        ),
      ).toBe(true);
      expect(rows[1]?.embedding).toEqual(encodeMemoryEmbedding([0.25, -0]));
      expect(owner.db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    },
  );

  it("bounds each serialized batch and preserves every row when provider vectors share an array", () => {
    const input = replacement();
    const chunk = input.chunks[0];
    if (!chunk) {
      throw new Error("Expected a fixture chunk");
    }
    const numericCases = [
      [0.125, 0.125],
      [-0, 0],
      [Number.NaN, null],
      [Infinity, null],
      [-Infinity, null],
      [-0.0000010000000000000002, -0.0000010000000000000002],
    ] as const;
    const vector = Array.from(
      { length: 16_384 },
      (_, index) => numericCases[index % numericCases.length]![0],
    );
    input.chunks = Array.from({ length: 32 }, (_, index) => ({
      ...chunk,
      startLine: index + 1,
      endLine: index + 1,
      hash: String(index),
    }));
    input.embeddings = input.chunks.map(() => vector);
    const rows: MemorySourceIndexRow[] = [];
    let json = "";
    let batches = 0;
    for (const batch of memoryPublicationBatches(input)) {
      batches++;
      expect(serialize(batch).byteLength).toBeLessThanOrEqual(512 * 1024);
      for (const fragment of batch) {
        expect(fragment.json.length).toBeLessThanOrEqual(16 * 1024);
        json += fragment.json;
        if (fragment.last) {
          rows.push(JSON.parse(json));
          json = "";
        }
      }
    }
    expect(batches).toBeGreaterThan(1);
    expect(json).toBe("");
    const expectedVector = Array.from(
      { length: vector.length },
      (_, index) => numericCases[index % numericCases.length]![1],
    );
    expect(rows).toEqual(input.chunks.map((row) => ({ chunk: row, embedding: expectedVector })));
  });

  it("reuses printed fragments per prepared chunks array until it is released", () => {
    const first = replacement();
    const printed = memoryPublicationInline(first)?.fragments;
    expect(printed).toBeDefined();
    expect(memoryPublicationInline({ ...first })?.fragments).toBe(printed);
    const other = replacement("second source text");
    const group = memoryPublicationGroup([first, other])!;
    const again = memoryPublicationGroup([first, other])!;
    expect(group[0]?.fragments).toBe(printed);
    again.forEach((source, index) => expect(source.fragments).toBe(group[index]?.fragments));
    releaseMemoryPublication(first);
    const released = memoryPublicationInline(first)?.fragments;
    expect(released).not.toBe(printed);
    expect(released).toEqual(printed);
  });
});
