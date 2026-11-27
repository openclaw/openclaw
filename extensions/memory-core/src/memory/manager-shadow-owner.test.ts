import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import type { MemorySourceIndexReplacement } from "./manager-source-index-kernel.js";

const owners: MemoryIndexDatabase[] = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  for (const owner of owners.splice(0)) {
    await owner.closeShadow();
  }
});

async function createShadow(filename: string) {
  const directory = tempDirs.make("memory-shadow-owner-");
  const owner = await MemoryIndexDatabase.openShadow(path.join(directory, filename), false);
  owners.push(owner);
  await owner.admitSchema({ cacheEnabled: false, ftsEnabled: true });
  return owner;
}

const chunk = { startLine: 1, endLine: 1, text: "retained text", hash: "chunk" };
const replacement: MemorySourceIndexReplacement = {
  source: "sessions",
  agentId: "main",
  sessionId: "one",
  model: "fts-only",
  now: 1,
  vectorReady: false,
  entry: { path: "sessions/one", hash: "source", mtimeMs: 1, size: 1 },
  embeddings: [],
  chunks: [{ ...chunk, importance: null, triggers: null, projectKey: null }],
};

function interceptWorkerClose(intercept: (close: () => Promise<void>) => Promise<void>) {
  const open = sqliteRuntime.openSqliteWorkerStore;
  vi.spyOn(sqliteRuntime, "openSqliteWorkerStore").mockImplementation(async (options) => {
    const store = await open(options);
    if (store) {
      const close = store.close.bind(store);
      vi.spyOn(store, "close").mockImplementationOnce(() => intercept(close));
    }
    return store;
  });
}
const assertCurrent = () => undefined;
const prepare = async () => true;
const replace = (owner: MemoryIndexDatabase) =>
  owner.replaceSource(replacement, assertCurrent, prepare);

describe("private shadow admission", () => {
  it("joins its retained worker before releasing the read-only shadow handle", async () => {
    const entered = createDeferred<void>();
    const released = createDeferred<void>();
    interceptWorkerClose(async (close) => {
      entered.resolve();
      await released.promise;
      await close();
    });
    const owner = await createShadow("retiring.sqlite");
    const db = owner.db;
    expect(() => db.exec("DELETE FROM memory_index_chunks")).toThrow(/readonly/i);
    const closing = owner.closeShadow();
    try {
      await entered.promise;
      expect(db.isOpen).toBe(true);
      expect(owner.shadowReleased).toBe(false);
    } finally {
      released.resolve();
      await closing;
    }
    expect(db.isOpen).toBe(false);
    expect(owner.shadowReleased).toBe(true);
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
    using writer = new DatabaseSync(owner.db.location()!);
    writer.exec(
      "CREATE TRIGGER refuse_source BEFORE INSERT ON memory_index_sources BEGIN SELECT RAISE(ABORT, 'source refused'); END",
    );
    await owner.closePublicationWorker();
    const refusedOpen = new Error("controlled publication open refusal");
    vi.spyOn(sqliteRuntime, "openSqliteWorkerStore").mockRejectedValueOnce(refusedOpen);
    await expect(replace(owner)).rejects.toBe(refusedOpen);
    await expect(replace(owner)).rejects.toMatchObject({
      code: "ERR_SQLITE_ERROR",
      errcode: 1811,
      entered: true,
      committed: false,
    });
    expect(owner.db.prepare("SELECT * FROM memory_index_chunks").all()).toEqual([]);
    expect(owner.db.prepare("SELECT * FROM memory_index_sources").all()).toEqual([]);
    writer.exec("DROP TRIGGER refuse_source");
    await expect(replace(owner)).resolves.toBe(true);
    expect(owner.db.prepare("SELECT text FROM memory_index_chunks").all()).toEqual([
      { text: "retained text" },
    ]);
  });

  it("retains committed data when the publication worker reports a close failure", async () => {
    interceptWorkerClose(async (close) => {
      await close();
      throw new Error("controlled native close failure");
    });
    const owner = await createShadow("shadow # committed.sqlite");
    await replace(owner);
    await expect(owner.closePublicationWorker()).rejects.toThrow("controlled native close failure");
    expect(owner.db.prepare("SELECT text FROM memory_index_chunks").all()).toEqual([
      { text: "retained text" },
    ]);
    await owner.closePublicationWorker();
  });
});
