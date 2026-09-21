import path from "node:path";
import { serialize } from "node:v8";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import * as sqliteWorkerRuntime from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import { readMemoryDatabaseRevision } from "./manager-db-kernel.js";
import { memoryPublicationBatches } from "./manager-publication-transfer.js";
import { openExistingSqliteWorkerBackend } from "./manager-publication.worker.js";
import { readMemoryShadowIdentity } from "./manager-shadow-task.js";
import type {
  MemorySourceIndexReplacement,
  MemorySourceIndexRow,
} from "./manager-source-index-kernel.js";

const owners: MemoryIndexDatabase[] = [];
const backends: ReturnType<typeof openExistingSqliteWorkerBackend>[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const backend of backends.splice(0)) {
      await backend.close();
    }
    for (const owner of owners.splice(0)) {
      await owner.closeShadow();
    }
    cleanup();
  }),
);

function createOwner() {
  const owner = MemoryIndexDatabase.openShadow(
    path.join(tempDirs.make("memory-publication-transfer-"), "index # é.sqlite"),
    false,
  );
  owners.push(owner);
  const schema = ensureMemoryIndexSchema({ db: owner.db, cacheEnabled: false, ftsEnabled: true });
  expect(schema.ftsAvailable).toBe(true);
  owner.fts.enabled = true;
  owner.fts.available = true;
  return owner;
}

function createBackend(owner: MemoryIndexDatabase) {
  const filename = owner.db.location()!;
  const backend = openExistingSqliteWorkerBackend(
    {
      fileIdentity: readMemoryShadowIdentity(filename),
      pragmas: {
        busy_timeout: 5000,
        synchronous: 2,
        foreign_keys: 1,
        wal_autocheckpoint: 1000,
        journal_size_limit: 67108864,
        checkpoint_fullfsync: 1,
      },
    },
    { databasePath: filename },
  );
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

  it("opens keyword publication when SQLite extension loading is unavailable", () => {
    const owner = createOwner();
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
    const backend = createBackend(owner);
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

  it.each([false, true])(
    "publishes and deletes keyword data with an unavailable configured extension (enabled: %s)",
    async (enabled) => {
      const owner = createOwner();
      owner.vector.enabled = enabled;
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

      const shadow = createOwner();
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
    },
  );

  it("preserves extension load failures when vector publication requires the extension", async () => {
    const owner = createOwner();
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
      const owner = createOwner();
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
    const owner = createOwner();
    const open = vi.spyOn(sqliteRuntime, "openSqliteWorkerStore");
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
    const owner = createOwner();
    // Non-BMP text spans many fragment boundaries, including pairs whose halves
    // could otherwise be separately converted to UTF-8 by SQLite TEXT bindings.
    const text = "a" + "😀".repeat(160_000) + '\n漢字 e\u0301 "quoted" \\ tail Violetmarker';
    const input = replacement(text);
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
        embedding: "[0.125,-0.5,1]",
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

  it("bounds each serialized batch and preserves every row when provider vectors share an array", () => {
    const input = replacement();
    const chunk = input.chunks[0];
    if (!chunk) {
      throw new Error("Expected a fixture chunk");
    }
    const vector = Array.from({ length: 16_384 }, (_, index) => index % 3);
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
    expect(rows).toEqual(input.chunks.map((row) => ({ chunk: row, embedding: vector })));
  });

  it.each(["incomplete", "out-of-order", "wrong-operation"] as const)(
    "rejects %s input before source mutation",
    (fault) => {
      const owner = createOwner();
      const backend = createBackend(owner);
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
