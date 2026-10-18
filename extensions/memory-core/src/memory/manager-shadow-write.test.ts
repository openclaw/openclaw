import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { SqliteWorkerError } from "openclaw/plugin-sdk/sqlite-runtime";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { seedMemoryForgetTombstones } from "../test-helpers.js";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import {
  createManagerIndexFixture,
  memoryIndexFixtureWriter,
} from "./manager-index.test-support.js";
import { MemorySourceIndexKernel } from "./manager-source-index-kernel.js";

const snapshot = (db: DatabaseSync) =>
  db.prepare("SELECT path, text FROM memory_index_chunks ORDER BY path").all();

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("private session source staging", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  afterEach(() => vi.restoreAllMocks());

  async function setup() {
    await fixture.seedSessionTranscript({
      sessionId: "shadow-session",
      messages: [{ role: "user", timestamp: 1, content: "Violet", senderIsOwner: true }],
    });
    const manager = await fixture.getFreshManager(
      fixture.createConfig({
        provider: "none",
        sources: ["memory", "sessions"],
        sessionMemory: true,
        vectorEnabled: false,
      }),
    );
    // SAFETY: this fixture owns the manager and inspects its published native store.
    const db = Reflect.get(manager, "db") as DatabaseSync;
    return { manager, db };
  }

  it("rejects a tombstone recorded after native staging before publishing the shadow", async () => {
    const { manager, db } = await setup();
    await manager.sync({ reason: "baseline", force: true });
    const before = snapshot(db);
    // oxlint-disable-next-line typescript/unbound-method -- Invoked with the intercepted database owner.
    const publish = MemoryIndexDatabase.prototype.publishShadow;
    vi.spyOn(MemoryIndexDatabase.prototype, "publishShadow").mockImplementation(function (
      this: MemoryIndexDatabase,
      ...args
    ) {
      // The shadow is complete; simulate forget advancing the published revision
      // before the final publication obtains transaction admission.
      seedMemoryForgetTombstones({ agentId: "main", sessionIds: ["shadow-session"] });
      return publish.apply(this, args);
    });
    await expect(manager.sync({ reason: "cli", force: true })).rejects.toThrow(
      "retry the full reindex",
    );
    expect(snapshot(db)).toEqual(before);
  });

  it("releases publication capacity and retries cleanup after a close failure", async () => {
    const { manager } = await setup();
    const open = sqliteRuntime.openOpenClawAgentSqliteWorkerStoreV2;
    const probeReleased: Array<() => Promise<unknown>> = [];
    vi.spyOn(sqliteRuntime, "openOpenClawAgentSqliteWorkerStoreV2").mockImplementation(
      async (...args) => {
        const worker = await open(...args);
        probeReleased.push(() =>
          worker.run(
            async () => "still admitted",
            () => undefined,
          ),
        );
        if (probeReleased.length === 1) {
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
      if (index === 0) {
        await expect(sync).rejects.toThrow("controlled generation close failure");
      } else {
        await sync;
      }
      expect(probeReleased).toHaveLength(index + 1);
      await expect(probeReleased[index]!()).rejects.toThrow("owner is closed");
      expect((await manager.search("Violet")).length).toBeGreaterThan(0);
    }
  });

  it("preserves publication and generation cleanup failures through sync", async () => {
    const { manager, db } = await setup();
    await manager.sync({ reason: "baseline", force: true });
    const before = snapshot(db);
    const database: unknown = Reflect.get(manager, "publishedDatabase");
    assert.instanceOf(database, MemoryIndexDatabase);
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
    assert.instanceOf(failure, AggregateError);
    expect(failure.cause).toBe(original);
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toBe(original);
    expect(failure.errors[1]).toBe(cleanup);
    expect(String(failure)).toContain(original.message);
    expect(String(failure)).toContain(cleanup.message);
    expect(snapshot(db)).toEqual(before);
    await manager.sync({ reason: "retry", force: true });
    expect(snapshot(db)).toEqual(before);
  });

  it("drains accepted staging before manager close releases its database", async () => {
    const { manager, db } = await setup();
    await fixture.seedSessionTranscript({
      sessionId: "shadow-sibling",
      messages: [{ role: "user", timestamp: 1, content: "Violet sibling preference." }],
    });
    const inspection = memoryIndexFixtureWriter(manager);
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    // oxlint-disable-next-line typescript/unbound-method -- Invoked with the intercepted database owner.
    const replace = MemoryIndexDatabase.prototype.replaceSource;
    vi.spyOn(MemoryIndexDatabase.prototype, "replaceSource").mockImplementation(async function (
      this: MemoryIndexDatabase,
      ...args
    ) {
      const result = await replace.apply(this, args);
      const [input] = args;
      const replacements = Array.isArray(input) ? input : [input];
      if (this.isShadow && replacements.some(({ source }) => source === "sessions")) {
        entered.resolve();
        await resume.promise;
      }
      return result;
    });
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
      expect(db.isOpen).toBe(false);
      expect(
        inspection
          .prepare("SELECT path FROM memory_index_sources WHERE source='sessions' ORDER BY path")
          .all(),
      ).toEqual([
        { path: "sessions/main/shadow-session.jsonl" },
        { path: "sessions/main/shadow-sibling.jsonl" },
      ]);
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
    let shadowPath: string | undefined;
    let shadowDatabase: DatabaseSync | undefined;
    // oxlint-disable-next-line typescript/unbound-method -- Invoked with the intercepted database owner.
    const prepareVector = MemoryIndexDatabase.prototype.prepareVector;
    vi.spyOn(MemoryIndexDatabase.prototype, "prepareVector").mockImplementation(async function (
      this: MemoryIndexDatabase,
      ...args
    ) {
      if (!this.isShadow) {
        return prepareVector.apply(this, args);
      }
      shadowDatabase = this.db;
      shadowPath = this.db.location()!;
      entered.resolve();
      await resume.promise;
      throw new Error("controlled late vector setup");
    });
    // SAFETY: the fixture injects the existing timeout outcome while leaving
    // the separate underlying setup task pending; no production hook is added.
    const owner = manager as unknown as {
      db: DatabaseSync;
      withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T>;
    };
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
    let replacementSettled = false;
    // oxlint-disable-next-line typescript/unbound-method -- Invoked with the intercepted database owner.
    const replace = MemoryIndexDatabase.prototype.replaceSource;
    const run = vi
      .spyOn(MemoryIndexDatabase.prototype, "replaceSource")
      .mockImplementation(async function (this: MemoryIndexDatabase, ...args) {
        try {
          return await replace.apply(this, args);
        } finally {
          replacementSettled = true;
        }
      });
    const sync = manager.sync({ reason: "cli", force: true });
    void sync.catch(() => undefined);
    let close: Promise<void> | undefined;
    let closed = false;
    try {
      await Promise.race([Promise.all([entered.promise, timedOut.promise]), sync]);
      await nextTurn();
      expect(shadowPath).toBeDefined();
      const shadow = shadowDatabase;
      assert.isDefined(shadow, "Expected the retained shadow database");
      const expectPendingSetup = () => {
        expect([shadow.isOpen, replacementSettled]).toEqual([true, false]);
        expect(
          shadow
            .prepare(
              "SELECT path FROM memory_index_sources UNION ALL SELECT path FROM memory_index_chunks",
            )
            .all(),
        ).toEqual([]);
      };
      expectPendingSetup();
      close = manager.close().then(() => {
        closed = true;
      });
      await nextTurn();
      expect(closed).toBe(false);
      expectPendingSetup();
      resume.resolve();
      await Promise.all([sync, close]);
      expect(run).toHaveBeenCalledTimes(1);
      expect(replacementSettled).toBe(true);
      expect(await fs.readdir(path.dirname(shadowPath!))).not.toContain(path.basename(shadowPath!));
    } finally {
      resume.resolve();
      await Promise.allSettled([sync, close]);
    }
  });

  it("preserves the published index when an accepted transfer fails without replaying inline", async () => {
    const { manager, db } = await setup();
    await fs.writeFile(
      path.join(fixture.paths.memory, "transfer.md"),
      "Violet transfer source.\n".repeat(30_000),
    );
    await manager.sync({ reason: "baseline", force: true });
    const before = snapshot(db);
    const transfer = await import("./manager-publication-transfer.js");
    const batches = transfer.memoryPublicationBatches;
    const rejectedTransfer = vi
      .spyOn(transfer, "memoryPublicationBatches")
      .mockImplementation(function* (replacement) {
        for (const batch of batches(replacement)) {
          yield batch;
          if (replacement.entry.path === "memory/transfer.md") {
            throw new SqliteWorkerError("controlled accepted transfer failure", "overloaded");
          }
        }
      });
    vi.spyOn(MemorySourceIndexKernel.prototype, "replaceRows").mockImplementation(() => {
      throw new Error("failed transfer replayed on the application thread");
    });
    await expect(manager.sync({ reason: "cli", force: true })).rejects.toMatchObject({
      code: "overloaded",
      message: "controlled accepted transfer failure",
    });
    expect(snapshot(db)).toEqual(before);
    rejectedTransfer.mockRestore();
    await manager.sync({ reason: "retry", force: true });
    expect(snapshot(db)).toEqual(before);
    const databasePath = db.location()!;
    await manager.close();
    const entries = await fs.readdir(path.dirname(databasePath));
    expect(entries.filter((name) => name.includes(".memory-reindex-"))).toEqual([]);
  });
});
