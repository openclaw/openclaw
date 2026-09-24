import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import type { MemorySourceIndexReplacement } from "./manager-source-index-kernel.js";

const owners: MemoryIndexDatabase[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const owner of owners.splice(0)) {
    await owner.closeShadow();
  }
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe("private shadow admission", () => {
  it("queues inherited reentrant callbacks until the native writer settles", async () => {
    const owner = new MemoryIndexDatabase(new DatabaseSync(":memory:"));
    owners.push(owner);
    const resume = createDeferred<void>();
    const events: string[] = [];
    let callback: Promise<number> | undefined;
    const native = owner.withPrivateAccess(
      async () => {
        events.push("native-start");
        callback = owner.withPrivateAccess(() => events.push("callback"), { reentrant: true });
        await resume.promise;
        events.push("native-settled");
      },
      { nativeWriter: true },
    );
    try {
      expect(events).toEqual(["native-start"]);
      resume.resolve();
      await native;
      await callback;
      expect(events).toEqual(["native-start", "native-settled", "callback"]);
    } finally {
      resume.resolve();
      await native.catch(() => undefined);
      await callback?.catch(() => undefined);
    }
  });

  it("invokes an idle writer immediately and preserves FIFO, caller ALS and undefined rejection", async () => {
    const owner = new MemoryIndexDatabase(new DatabaseSync(":memory:"));
    owners.push(owner);
    const context = new AsyncLocalStorage<string>();
    const resume = createDeferred<void>();
    const events: Array<string | undefined> = [];
    const first = context.run("first", () =>
      owner.withPrivateAccess(async () => {
        events.push(context.getStore());
        await resume.promise;
      }),
    );
    void first.catch(() => undefined);
    expect(events).toEqual(["first"]);
    const second = context.run("second", () =>
      owner.withPrivateAccess(async () => {
        events.push(context.getStore());
        return owner.withPrivateAccess(() => context.getStore(), { reentrant: true });
      }),
    );
    const third = context.run("third", () =>
      owner.withPrivateAccess(() => events.push(context.getStore())),
    );
    resume.reject(undefined);
    await expect(first).rejects.toBeUndefined();
    await expect(second).resolves.toBe("second");
    await third;
    expect(events).toEqual(["first", "second", "third"]);
  });

  it("retains SQLite failure codes and rolls back the failed Worker callback", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-shadow-owner-"));
    directories.push(directory);
    const owner = MemoryIndexDatabase.openShadow(
      path.join(directory, "shadow # unicode é.sqlite"),
      false,
    );
    owners.push(owner);
    ensureMemoryIndexSchema({ db: owner.db, cacheEnabled: false, ftsEnabled: true });
    owner.fts.enabled = true;
    owner.fts.available = true;
    owner.db.exec(
      "CREATE TRIGGER refuse_source BEFORE INSERT ON memory_index_sources BEGIN SELECT RAISE(ABORT, 'source refused'); END",
    );
    const replacement: Extract<MemorySourceIndexReplacement, { source: "sessions" }> = {
      source: "sessions",
      agentId: "main",
      sessionId: "one",
      model: "fts-only",
      now: 1,
      vectorReady: false,
      entry: { path: "sessions/one", hash: "source", mtimeMs: 1, size: 1 },
      embeddings: [],
      chunks: [
        {
          startLine: 1,
          endLine: 1,
          text: "retained text",
          hash: "chunk",
          importance: null,
          triggers: null,
          projectKey: null,
        },
      ],
    };
    const refusedOpen = new Error("controlled publication open refusal");
    vi.spyOn(sqliteRuntime, "openSqliteWorkerStore").mockRejectedValueOnce(refusedOpen);
    await expect(
      owner.replaceSource(
        replacement,
        () => undefined,
        async () => true,
      ),
    ).rejects.toBe(refusedOpen);
    await expect(
      owner.replaceSource(
        replacement,
        () => undefined,
        async () => true,
      ),
    ).rejects.toMatchObject({
      code: "ERR_SQLITE_ERROR",
      errcode: 1811,
      entered: true,
      committed: false,
    });
    expect(owner.db.prepare("SELECT * FROM memory_index_chunks").all()).toEqual([]);
    expect(owner.db.prepare("SELECT * FROM memory_index_sources").all()).toEqual([]);
    owner.db.exec("DROP TRIGGER refuse_source");
    await expect(
      owner.replaceSource(
        replacement,
        () => undefined,
        async () => true,
      ),
    ).resolves.toEqual({
      beforeRevision: expect.any(Number),
      databaseRevision: expect.any(Number),
    });
    expect(owner.db.prepare("SELECT text FROM memory_index_chunks").all()).toEqual([
      { text: "retained text" },
    ]);
  });

  it("retains committed data when the publication worker reports a close failure", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-shadow-close-"));
    directories.push(directory);
    const owner = MemoryIndexDatabase.openShadow(
      path.join(directory, "shadow # committed.sqlite"),
      false,
    );
    owners.push(owner);
    ensureMemoryIndexSchema({ db: owner.db, cacheEnabled: false, ftsEnabled: true });
    owner.fts.enabled = true;
    owner.fts.available = true;
    const open = sqliteRuntime.openSqliteWorkerStore;
    vi.spyOn(sqliteRuntime, "openSqliteWorkerStore").mockImplementation(async (options) => {
      const store = await open(options);
      if (store) {
        const close = store.close.bind(store);
        vi.spyOn(store, "close").mockImplementationOnce(async () => {
          await close();
          throw new Error("controlled native close failure");
        });
      }
      return store;
    });
    await owner.replaceSource(
      {
        source: "sessions",
        agentId: "main",
        sessionId: "committed",
        model: "fts-only",
        now: 1,
        vectorReady: false,
        entry: { path: "sessions/committed", hash: "source", mtimeMs: 1, size: 1 },
        embeddings: [],
        chunks: [
          {
            startLine: 1,
            endLine: 1,
            text: "committed text",
            hash: "chunk",
            importance: null,
            triggers: null,
            projectKey: null,
          },
        ],
      },
      () => undefined,
      async () => true,
    );
    await expect(owner.closePublicationWorker()).rejects.toThrow("controlled native close failure");
    expect(owner.db.prepare("SELECT text FROM memory_index_chunks").all()).toEqual([
      { text: "committed text" },
    ]);
    await owner.closePublicationWorker();
  });
});
