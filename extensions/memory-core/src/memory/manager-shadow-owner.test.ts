import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  configureMemorySqliteWalMaintenance,
  ensureMemoryIndexSchema,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
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

async function createShadow(filename: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-shadow-owner-"));
  directories.push(directory);
  const owner = MemoryIndexDatabase.openShadow(path.join(directory, filename), false);
  owners.push(owner);
  ensureMemoryIndexSchema({ db: owner.db, cacheEnabled: false, ftsEnabled: true });
  owner.fts.enabled = true;
  owner.fts.available = true;
  return owner;
}

function sessionReplacement(sessionId: string, text: string): MemorySourceIndexReplacement {
  return {
    source: "sessions",
    agentId: "main",
    sessionId,
    model: "fts-only",
    now: 1,
    vectorReady: false,
    entry: { path: `sessions/${sessionId}`, hash: "source", mtimeMs: 1, size: 1 },
    embeddings: [],
    chunks: [
      {
        startLine: 1,
        endLine: 1,
        text,
        hash: "chunk",
        importance: null,
        triggers: null,
        projectKey: null,
      },
    ],
  };
}

describe("private shadow admission", () => {
  it("joins the WAL owner before closing a shadow database", async () => {
    const owner = await createShadow("retiring.sqlite");
    const maintenance = configureMemorySqliteWalMaintenance(owner.db);
    const stop = maintenance.stop;
    const entered = createDeferred<void>();
    const released = createDeferred<void>();
    vi.spyOn(maintenance, "stop").mockImplementationOnce(async () => {
      entered.resolve();
      await released.promise;
      await stop();
    });
    const closing = owner.closeShadow();
    try {
      await entered.promise;
      expect(owner.db.isOpen).toBe(true);
      expect(owner.shadowReleased).toBe(false);
      released.resolve();
      await closing;
      expect(owner.db.isOpen).toBe(false);
      expect(owner.shadowReleased).toBe(true);
    } finally {
      released.resolve();
      await closing;
    }
  });

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

  it("retains SQLite failure codes and rolls back the failed Worker callback", async () => {
    const owner = await createShadow("shadow # unicode é.sqlite");
    owner.db.exec(
      "CREATE TRIGGER refuse_source BEFORE INSERT ON memory_index_sources BEGIN SELECT RAISE(ABORT, 'source refused'); END",
    );
    const replacement = sessionReplacement("one", "retained text");
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
    const owner = await createShadow("shadow # committed.sqlite");
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
      sessionReplacement("committed", "committed text"),
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
