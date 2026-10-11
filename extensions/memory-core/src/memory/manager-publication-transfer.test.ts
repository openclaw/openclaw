import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import {
  encodeMemoryEmbedding,
  ensureMemoryIndexSchema,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import * as sqliteWorkerRuntime from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureMemorySessionTombstones } from "../memory-session-tombstones.js";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import { readMemoryDatabaseRevision } from "./manager-db-kernel.js";
import {
  memoryEmbeddingCacheBatches,
  memoryPublicationBatches,
} from "./manager-publication-transfer.js";
import {
  bindSqliteWorkerBackend,
  openExistingSqliteWorkerBackend,
} from "./manager-publication.worker.js";
import { readMemoryShadowIdentity } from "./manager-shadow-task.js";
import type {
  MemorySourceIndexReplacement,
  MemorySourceIndexRow,
} from "./manager-source-index-kernel.js";

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
    writer = new DatabaseSync(owner.db.location()!);
    writer.exec("PRAGMA busy_timeout = 5000");
    fixtureWriters.set(owner, writer);
  }
  return writer;
}

async function createBackend(
  owner: MemoryIndexDatabase,
  admit?: (stage: "transaction" | "commit") => void,
) {
  const filename = owner.db.location()!;
  const writer = fixtureWriter(owner);
  const readPragma = (name: string) => {
    const row = writer.prepare(`PRAGMA ${name}`).get();
    return Number(row?.[name] ?? row?.timeout);
  };
  const input = {
    fileIdentity: readMemoryShadowIdentity(filename),
    pragmas: {
      busy_timeout: readPragma("busy_timeout"),
      synchronous: readPragma("synchronous"),
      foreign_keys: readPragma("foreign_keys"),
      journal_size_limit: readPragma("journal_size_limit"),
      checkpoint_fullfsync: readPragma("checkpoint_fullfsync"),
    },
  };
  const backend = admit
    ? bindSqliteWorkerBackend(input, { databasePath: filename, database: writer, admit })
    : await openExistingSqliteWorkerBackend(input, { databasePath: filename });
  backends.push(backend);
  return backend;
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

  it("avoids unused connection work for scalar publications", () => {
    const filename = path.join(tempDirs.make("memory-publication-input-"), "index.sqlite");
    const db = new DatabaseSync(filename);
    try {
      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
      db.exec("CREATE TABLE chunks_vec (id TEXT)");
      const sql = vi.spyOn(db, "exec");
      const reads = vi.spyOn(db, "prepare");
      const bind = () =>
        bindSqliteWorkerBackend(
          { kind: "agent" },
          { databasePath: filename, database: db, admit: () => undefined },
        );
      const state = {
        vector: { enabled: false, available: false },
        fts: { enabled: false, available: false },
      };
      const scalar = bind();
      expect(scalar.execute({ type: "vector.retireLegacy", input: { state } })).toEqual({
        ok: true,
        value: true,
      });
      expect(
        scalar.execute({
          type: "vector.retireLegacy",
          input: { state: { ...state, extensionPath: path.join(filename, "missing-vec") } },
        }),
      ).toEqual({ ok: true, value: false });
      expect(
        reads.mock.calls.filter(([statement]) =>
          /^PRAGMA (synchronous|journal_size_limit|checkpoint_fullfsync)$/u.test(statement),
        ),
      ).toEqual([]);
      expect(scalar.execute({ type: "connection.inspect", input: undefined })).toEqual({
        fileIdentity: readMemoryShadowIdentity(filename),
        pragmas: {
          busy_timeout: expect.any(Number),
          synchronous: expect.any(Number),
          foreign_keys: expect.any(Number),
          journal_size_limit: expect.any(Number),
          checkpoint_fullfsync: expect.any(Number),
        },
      });
      scalar.close();
      expect(
        sql.mock.calls.filter(([statement]) => /memory_publication_input/u.test(statement)),
      ).toEqual([]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'chunks_vec'").all()).toEqual(
        [],
      );

      const staged = bind();
      const input = replacement("staged text survives scalar cleanup");
      const { chunks, embeddings: _embeddings, ...header } = input;
      staged.execute({
        type: "stage.start",
        input: { operation: "staged", header, rows: chunks.length },
      });
      for (const fragments of memoryPublicationBatches(input)) {
        staged.execute({ type: "stage.append", input: { operation: "staged", fragments } });
      }
      expect(
        staged.execute({ type: "source.replace", input: { operation: "staged", state } }),
      ).toMatchObject({ ok: true });
      staged.close();
      expect(db.prepare("SELECT text FROM memory_index_chunks").all()).toEqual([
        { text: "staged text survives scalar cleanup" },
      ]);
      expect(
        db
          .prepare("SELECT name FROM sqlite_temp_master WHERE name = 'memory_publication_input'")
          .all(),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  it.each(["success", "begin", "write", "transaction", "commit"] as const)(
    "restores publication timeout once through %s settlement",
    async (fault) => {
      const owner = await createOwner();
      const db = fixtureWriter(owner);
      db.exec(`INSERT INTO memory_index_sources(path, source, hash, mtime, size)
        VALUES ('sessions/current', 'sessions', 'old', 1, 1)`);
      const stages: string[] = [];
      const backend = await createBackend(owner, (stage) => {
        stages.push(stage);
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
      const exec = vi.spyOn(db, "exec");
      try {
        const outcome = backend.execute({
          type: "source.refresh",
          input: { path: "sessions/current", hash: "new", mtime: 2, size: 2, expectedHash: "old" },
        });
        expect(outcome).toMatchObject(
          fault === "success"
            ? { ok: true, value: true }
            : { ok: false, entered: fault !== "begin", committed: false },
        );
        expect(stages).toEqual(
          fault === "begin"
            ? []
            : fault === "write" || fault === "transaction"
              ? ["transaction"]
              : ["transaction", "commit"],
        );
        expect(
          exec.mock.calls.filter(([sql]) => sql === "PRAGMA busy_timeout = 5000"),
        ).toHaveLength(1);
        expect(db.isTransaction).toBe(false);
        expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
        expect(db.prepare("SELECT hash FROM memory_index_sources").get()).toEqual({
          hash: fault === "success" ? "new" : "old",
        });
      } finally {
        exec.mockRestore();
        locker?.exec("ROLLBACK");
        locker?.close();
      }
    },
  );

  it.each([1, 2])("retains publication restoration failures (%i attempts)", async (failures) => {
    const owner = await createOwner();
    const db = fixtureWriter(owner);
    db.exec(`INSERT INTO memory_index_sources(path, source, hash, mtime, size)
      VALUES ('sessions/current', 'sessions', 'old', 1, 1)`);
    const admit = vi.fn();
    const backend = await createBackend(owner, admit);
    const nativeExec = db.exec.bind(db);
    let attempts = 0;
    const failure = new Error("timeout restoration refused");
    const exec = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "PRAGMA busy_timeout = 5000" && ++attempts <= failures) {
        throw failure;
      }
      return nativeExec(sql);
    });
    const refresh = () =>
      backend.execute({
        type: "source.refresh",
        input: { path: "sessions/current", hash: "new", mtime: 2, size: 2, expectedHash: "old" },
      });
    try {
      if (failures === 1) {
        expect(refresh()).toMatchObject({
          ok: false,
          entered: true,
          committed: false,
          error: { message: failure.message },
        });
        expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
      } else {
        expect(refresh).toThrow(failure);
      }
      expect(attempts).toBe(2);
      expect(admit).not.toHaveBeenCalled();
      expect(db.isTransaction).toBe(false);
      expect(db.prepare("SELECT hash FROM memory_index_sources").get()).toEqual({ hash: "old" });
    } finally {
      exec.mockRestore();
      db.exec("PRAGMA busy_timeout = 5000");
    }
  });

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
    const { chunks, embeddings: _embeddings, ...header } = replacement();
    backend.execute({
      type: "stage.start",
      input: { operation: "fts", header, rows: chunks.length },
    });
    for (const fragments of memoryPublicationBatches(replacement())) {
      backend.execute({ type: "stage.append", input: { operation: "fts", fragments } });
    }
    backend.execute({ type: "stage.discard", input: { operation: "fts" } });
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
        sourceHasVectors: false,
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
        (store, operation, assertCurrent, nativeLocations) =>
          run(
            store,
            (scope) =>
              operation({
                execute: async (command) => {
                  commands.push(command.type);
                  if (command.type === "source.replace") {
                    throw original;
                  }
                  if (command.type === "stage.discard") {
                    throw new Error("retired publication scope");
                  }
                  return scope.execute(command);
                },
              }),
            assertCurrent,
            nativeLocations,
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
      const result = owner.replaceSource(
        replacement(),
        () => undefined,
        async () => true,
      );
      if (failClose) {
        const failure: unknown = await result.catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        if (!(failure instanceof AggregateError)) {
          throw new Error("Expected publication and cleanup failures");
        }
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
      expect(commands).toEqual(["stage.start", "stage.append", "source.replace"]);
      expect(owner.db.prepare("SELECT * FROM memory_index_sources").all()).toEqual([]);
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
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(serialize(batch).byteLength).toBeLessThanOrEqual(512 * 1024);
    }
    await owner.replaceSource(
      input,
      () => undefined,
      async () => true,
    );
    expect(
      owner.db
        .prepare(
          "SELECT path, source, start_line, end_line, hash, model, text, embedding, updated_at " +
            "FROM memory_index_chunks",
        )
        .all(),
    ).toEqual([
      {
        path: input.entry.path,
        source: "memory",
        start_line: 1,
        end_line: 3,
        hash: "chunk-hash",
        model: "transfer-model",
        text,
        embedding: encodeMemoryEmbedding(vector.map((value) => (Object.is(value, -0) ? 0 : value))),
        updated_at: 101,
      },
    ]);
    expect(
      owner.db.prepare("SELECT path, source, hash, mtime, size FROM memory_index_sources").all(),
    ).toEqual([
      {
        path: input.entry.path,
        source: "memory",
        hash: "source-hash",
        mtime: 100.25,
        size: Buffer.byteLength(text),
      },
    ]);
    expect(
      owner.db
        .prepare("SELECT importance, triggers, project_key FROM memory_index_chunk_recall_metadata")
        .all(),
    ).toEqual([{ importance: 7, triggers: '["漢字","🧠"]', project_key: "project/é" }]);
    expect(
      owner.db
        .prepare(
          "SELECT origin_class, session_kind, observed_at, supersedes_key FROM memory_index_chunk_provenance",
        )
        .all(),
    ).toEqual([
      {
        origin_class: "owner",
        session_kind: "interactive",
        observed_at: 90,
        supersedes_key: "old/🔑",
      },
    ]);
    expect(
      owner.db
        .prepare(
          "SELECT path FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH 'Violetmarker'",
        )
        .all(),
    ).toEqual([{ path: input.entry.path }]);
  });

  it("roundtrips an over-message cache vector while enforcing revision, tombstone, and capacity fences", async () => {
    const owner = await createOwner();
    const writer = fixtureWriter(owner);
    ensureMemoryIndexSchema({ db: writer, cacheEnabled: true, ftsEnabled: true });
    ensureMemorySessionTombstones(writer);
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
      owner.db.prepare("SELECT * FROM memory_embedding_cache ORDER BY hash").all();
    const before = readRows();
    const staleRevision = readMemoryDatabaseRevision(owner.db);
    writer.exec("UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1");
    const outcomes: Array<boolean | undefined> = [];
    const assertCurrent = () => undefined;
    outcomes.push(
      await owner.mutateEmbeddingCache(
        {
          kind: "clear",
          identities: [
            {
              provider: header.provider.id,
              model: header.provider.model,
              providerKey: header.providerKey,
            },
          ],
        },
        assertCurrent,
        () => staleRevision,
        () => undefined,
      ),
    );
    expect(outcomes).toEqual([false]);
    expect(readRows()).toEqual(before);

    writer
      .prepare(`INSERT INTO memory_session_tombstones
      (session_id, agent_id, reason, created_at) VALUES ('forgotten', 'main', 'forgotten', 1)`)
      .run();
    const vector = Array.from({ length: 4 * 1024 * 1024 + 1 }, () => 0.125);
    vector.splice(0, 4, -0, Number.MIN_VALUE, Number.MAX_VALUE, 1 + Number.EPSILON);
    const entries = [
      { hash: "large", embedding: vector },
      { hash: "survivor", embedding: [0.25, -0] },
      { hash: "forgotten", embedding: [9], sessionId: "forgotten" },
    ];
    expect(serialize(entries).byteLength).toBeGreaterThan(32 * 1024 * 1024);
    let batches = 0;
    for (const batch of memoryEmbeddingCacheBatches(entries)) {
      batches++;
      expect(serialize(batch).byteLength).toBeLessThanOrEqual(512 * 1024);
    }
    expect(batches).toBeGreaterThan(1);
    outcomes.push(
      await owner.mutateEmbeddingCache(
        { kind: "upsert", header, entries },
        assertCurrent,
        () => readMemoryDatabaseRevision(owner.db),
        () => undefined,
      ),
    );
    expect(outcomes).toEqual([false, true]);
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
  });

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
    let part = 0;
    let batches = 0;
    for (const batch of memoryPublicationBatches(input)) {
      batches++;
      expect(serialize(batch).byteLength).toBeLessThanOrEqual(512 * 1024);
      for (const fragment of batch) {
        expect(fragment.json.length).toBeLessThanOrEqual(16 * 1024);
        expect(fragment.row).toBe(rows.length);
        expect(fragment.part).toBe(part++);
        json += fragment.json;
        if (fragment.last) {
          rows.push(JSON.parse(json));
          json = "";
          part = 0;
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

  it.each(["incomplete", "out-of-order", "wrong-operation"] as const)(
    "rejects %s input before source mutation",
    async (fault) => {
      const owner = await createOwner();
      const backend = await createBackend(owner);
      const { chunks, embeddings: _embeddings, ...header } = replacement();
      backend.execute({
        type: "stage.start",
        input: { operation: "owned", header, rows: chunks.length },
      });
      const append = () =>
        backend.execute({
          type: "stage.append",
          input: {
            operation: fault === "wrong-operation" ? "stale" : "owned",
            fragments: [{ row: 0, part: fault === "out-of-order" ? 1 : 0, json: "{", last: false }],
          },
        });
      if (fault === "incomplete") {
        append();
      } else {
        expect(append).toThrow(fault === "out-of-order" ? "out of order" : "owner changed");
      }
      expect(() =>
        backend.execute({
          type: "source.replace",
          input: {
            operation: "owned",
            state: {
              vector: { enabled: false, available: false },
              fts: { enabled: true, available: true },
            },
          },
        }),
      ).toThrow("not sealed");
      expect(owner.db.prepare("SELECT * FROM memory_index_sources").all()).toEqual([]);
      expect(owner.db.prepare("SELECT * FROM memory_index_chunks").all()).toEqual([]);
      backend.execute({ type: "stage.discard", input: { operation: "owned" } });
      expect(() =>
        backend.execute({ type: "stage.start", input: { operation: "next", header, rows: 0 } }),
      ).not.toThrow();
    },
  );
});
