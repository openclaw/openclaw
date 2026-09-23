import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as storage from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { SqliteWorkerError } from "openclaw/plugin-sdk/sqlite-runtime";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedMemoryForgetTombstones } from "../test-helpers.js";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import { MemorySourceIndexKernel } from "./manager-source-index-kernel.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("private session source staging", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  afterEach(() => vi.restoreAllMocks());

  async function setup(vectorEnabled = false) {
    await fixture.seedSessionTranscript({
      sessionId: "shadow-session",
      messages: [
        {
          role: "user",
          timestamp: 1,
          content: vectorEnabled
            ? "Violet session preference. Beta."
            : "Violet session preference.",
          senderIsOwner: true,
        },
      ],
    });
    const manager = await fixture.getFreshManager(
      fixture.createConfig({
        provider: vectorEnabled ? "openai" : "none",
        sources: ["memory", "sessions"],
        sessionMemory: true,
        vectorEnabled,
      }),
    );
    // SAFETY: this fixture owns the manager and inspects its published native store.
    const db = Reflect.get(manager, "db") as DatabaseSync;
    return { manager, db };
  }

  it.each([
    { mode: "FTS-only", vectorEnabled: false },
    { mode: "vector", vectorEnabled: true },
  ])(
    "publishes forced $mode memory and session sources without the application-thread kernel",
    async ({ vectorEnabled }) => {
      const { manager, db } = await setup(vectorEnabled);
      vi.spyOn(MemorySourceIndexKernel.prototype, "replace").mockImplementation(() => {
        throw new Error("source publication reached the application thread");
      });
      await manager.sync({ reason: "cli", force: true });
      expect(
        db.prepare("SELECT DISTINCT source FROM memory_index_chunks ORDER BY source").all(),
      ).toEqual([{ source: "memory" }, { source: "sessions" }]);
      const sessionChunks = db
        .prepare(
          "SELECT id, text, embedding FROM memory_index_chunks WHERE source='sessions' ORDER BY id",
        )
        .all();
      expect(sessionChunks).toEqual([
        {
          id: expect.any(String),
          text: expect.stringContaining("Violet session preference."),
          embedding: storage.encodeMemoryEmbedding(vectorEnabled ? [0, 1, 0, 0] : []),
        },
      ]);
      if (vectorEnabled) {
        const vectors = db
          .prepare(
            "SELECT v.id, hex(v.embedding) AS embedding FROM memory_index_chunks_vec AS v " +
              "JOIN memory_index_chunks AS c ON c.id = v.id WHERE c.source = 'sessions' ORDER BY v.id",
          )
          .all();
        const embedding = Buffer.from(new Float32Array([0, 1, 0, 0]).buffer)
          .toString("hex")
          .toUpperCase();
        expect(vectors).toEqual(sessionChunks.map(({ id }) => ({ id, embedding })));
      }
      await manager.close();
      const entries = await fs.readdir(path.dirname(db.location()!));
      expect(entries.filter((name) => name.includes(".memory-reindex-"))).toEqual([]);
    },
  );

  it("rejects a tombstone recorded after native staging before publishing the shadow", async () => {
    const { manager, db } = await setup();
    await manager.sync({ reason: "baseline", force: true });
    const before = db.prepare("SELECT path, text FROM memory_index_chunks ORDER BY path").all();
    // oxlint-disable-next-line typescript/unbound-method -- Invoked with the intercepted database owner.
    const publish = MemoryIndexDatabase.prototype.publishShadow;
    vi.spyOn(MemoryIndexDatabase.prototype, "publishShadow").mockImplementation(
      function (this: MemoryIndexDatabase, input, assertCurrent) {
        // The shadow is complete; simulate forget advancing the published revision
        // before the final publication obtains transaction admission.
        seedMemoryForgetTombstones({ agentId: "main", sessionIds: ["shadow-session"] });
        return publish.call(this, input, assertCurrent);
      },
    );
    await expect(manager.sync({ reason: "cli", force: true })).rejects.toThrow(
      "retry the full reindex",
    );
    expect(db.prepare("SELECT path, text FROM memory_index_chunks ORDER BY path").all()).toEqual(
      before,
    );
  });

  it.each([false, true])(
    "releases publication capacity and retries cleanup (close failure: %s)",
    async (failClose) => {
      const { manager } = await setup();
      const open = sqliteRuntime.openOpenClawAgentSqliteWorkerStore;
      const probeReleased: Array<() => Promise<unknown>> = [];
      vi.spyOn(sqliteRuntime, "openOpenClawAgentSqliteWorkerStore").mockImplementation(
        async (...args) => {
          const worker = await open(...args);
          probeReleased.push(() =>
            worker.run(
              async () => "still admitted",
              () => undefined,
            ),
          );
          if (failClose && probeReleased.length === 1) {
            const close = worker.close.bind(worker);
            vi.spyOn(worker, "close").mockImplementationOnce(async () => {
              await close();
              throw new Error("controlled generation close failure");
            });
          }
          return worker;
        },
      );
      for (let index = 0; index < 2; index++) {
        const sync = manager.sync({ reason: "repeat-generation", force: true });
        if (failClose && index === 0) {
          await expect(sync).rejects.toThrow("controlled generation close failure");
        } else {
          await sync;
        }
        expect(probeReleased).toHaveLength(index + 1);
        await expect(probeReleased[index]!()).rejects.toThrow("owner is closed");
        expect((await manager.search("Violet")).length).toBeGreaterThan(0);
      }
    },
  );

  it("preserves publication and generation cleanup failures through sync", async () => {
    const { manager, db } = await setup();
    await manager.sync({ reason: "baseline", force: true });
    const before = db.prepare("SELECT path, text FROM memory_index_chunks ORDER BY path").all();
    const database: unknown = Reflect.get(manager, "publishedDatabase");
    if (!(database instanceof MemoryIndexDatabase)) {
      throw new Error("Expected the manager's published database owner");
    }
    const original = new SqliteWorkerError(
      "controlled publication result failure",
      "outcome-unknown",
    );
    const cleanup = new Error("controlled generation cleanup failure");
    vi.spyOn(MemoryIndexDatabase.prototype, "publishShadow").mockRejectedValueOnce(original);
    vi.spyOn(database, "closePublicationWorker")
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(cleanup);
    const failure: unknown = await manager
      .sync({ reason: "failure", force: true })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) {
      throw new Error("Expected sync and cleanup failures");
    }
    expect(failure.cause).toBe(original);
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toBe(original);
    expect(failure.errors[1]).toBe(cleanup);
    expect(String(failure)).toContain(original.message);
    expect(String(failure)).toContain(cleanup.message);
    expect(db.prepare("SELECT path, text FROM memory_index_chunks ORDER BY path").all()).toEqual(
      before,
    );
    await manager.sync({ reason: "retry", force: true });
    expect(db.prepare("SELECT path, text FROM memory_index_chunks ORDER BY path").all()).toEqual(
      before,
    );
  });

  it("drains accepted staging before manager close releases its database", async () => {
    const { manager, db } = await setup();
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    // oxlint-disable-next-line typescript/unbound-method -- Invoked with the intercepted database owner.
    const replace = MemoryIndexDatabase.prototype.replaceSource;
    vi.spyOn(MemoryIndexDatabase.prototype, "replaceSource").mockImplementation(
      async function (this: MemoryIndexDatabase, input, assertCurrent, prepare) {
        const result = await replace.call(this, input, assertCurrent, prepare);
        if (this.isShadow && input.source === "sessions") {
          entered.resolve();
          await resume.promise;
        }
        return result;
      },
    );
    const sync = manager.sync({ reason: "cli", force: true });
    void sync.catch(() => undefined);
    let close: Promise<void> | undefined;
    let closed = false;
    try {
      await Promise.race([entered.promise, sync]);
      close = manager.close().then(() => {
        closed = true;
      });
      await nextTurn();
      expect(closed).toBe(false);
      resume.resolve();
      await Promise.all([sync, close]);
      expect(
        db.prepare("SELECT source FROM memory_index_sources WHERE source='sessions'").all(),
      ).toEqual([{ source: "sessions" }]);
    } finally {
      resume.resolve();
      await Promise.allSettled([sync, close]);
    }
  });

  it("retains late vector setup after its timeout-facing promise rejects", async () => {
    await fixture.seedSessionTranscript({
      sessionId: "late-vector",
      messages: [{ role: "user", timestamp: 1, content: "Violet late vector preference." }],
    });
    const manager = await fixture.getFreshManager(
      fixture.createConfig({
        provider: "openai",
        sources: ["sessions"],
        sessionMemory: true,
        vectorEnabled: true,
      }),
    );
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    const timedOut = createDeferred<void>();
    const load = storage.loadSqliteVecExtension;
    vi.spyOn(storage, "loadSqliteVecExtension").mockImplementation(async (input) => {
      if (!input.db.location()?.includes(".memory-reindex-")) {
        return load(input);
      }
      entered.resolve();
      await resume.promise;
      return { ok: false, error: "controlled late vector setup" };
    });
    // SAFETY: the fixture injects the existing timeout outcome while leaving
    // the separate underlying setup task pending; no production hook is added.
    const owner = manager as unknown as {
      db: DatabaseSync;
      withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T>;
    };
    let shadowPath: string | undefined;
    const withTimeout = owner.withTimeout.bind(owner);
    vi.spyOn(owner, "withTimeout").mockImplementation(
      <T>(promise: Promise<T>, timeoutMs: number, message: string) => {
        const databasePath = message.startsWith("sqlite-vec load timed out")
          ? owner.db.location()
          : undefined;
        if (!databasePath?.includes(".memory-reindex-")) {
          return withTimeout(promise, timeoutMs, message);
        }
        shadowPath = databasePath;
        void promise.catch(() => undefined);
        timedOut.resolve();
        return Promise.reject(new Error(message));
      },
    );
    const run = vi.spyOn(MemoryIndexDatabase.prototype, "replaceSource");
    // replaceSource queues first; the owned store opens only after private admission.
    const open = vi.spyOn(sqliteRuntime, "openSqliteWorkerStore");
    const shadowOpens = () =>
      open.mock.calls.filter(([options]) => options.databasePath === shadowPath);
    const sync = manager.sync({ reason: "cli", force: true });
    void sync.catch(() => undefined);
    let close: Promise<void> | undefined;
    let closed = false;
    try {
      await Promise.race([Promise.all([entered.promise, timedOut.promise]), sync]);
      await nextTurn();
      expect(shadowPath).toBeDefined();
      expect(shadowOpens()).toHaveLength(0);
      close = manager.close().then(() => {
        closed = true;
      });
      await nextTurn();
      expect(closed).toBe(false);
      resume.resolve();
      await Promise.all([sync, close]);
      expect(run).toHaveBeenCalledTimes(1);
      expect(shadowOpens()).toHaveLength(1);
    } finally {
      resume.resolve();
      await Promise.allSettled([sync, close]);
    }
  });

  it("preserves the published index when an accepted transfer fails without replaying inline", async () => {
    const { manager, db } = await setup();
    await manager.sync({ reason: "baseline", force: true });
    const before = db.prepare("SELECT path, text FROM memory_index_chunks ORDER BY path").all();
    const transfer = await import("./manager-publication-transfer.js");
    const batches = transfer.memoryPublicationBatches;
    const rejectedTransfer = vi
      .spyOn(transfer, "memoryPublicationBatches")
      .mockImplementation(function* (replacement) {
        for (const batch of batches(replacement)) {
          yield batch;
          if (replacement.source === "sessions") {
            throw new SqliteWorkerError("controlled accepted transfer failure", "overloaded");
          }
        }
      });
    vi.spyOn(MemorySourceIndexKernel.prototype, "replace").mockImplementation(() => {
      throw new Error("failed transfer replayed on the application thread");
    });
    await expect(manager.sync({ reason: "cli", force: true })).rejects.toMatchObject({
      code: "overloaded",
      message: "controlled accepted transfer failure",
    });
    expect(db.prepare("SELECT path, text FROM memory_index_chunks ORDER BY path").all()).toEqual(
      before,
    );
    rejectedTransfer.mockRestore();
    await manager.sync({ reason: "retry", force: true });
    expect(db.prepare("SELECT path, text FROM memory_index_chunks ORDER BY path").all()).toEqual(
      before,
    );
    await manager.close();
    const entries = await fs.readdir(path.dirname(db.location()!));
    expect(entries.filter((name) => name.includes(".memory-reindex-"))).toEqual([]);
  });
});
