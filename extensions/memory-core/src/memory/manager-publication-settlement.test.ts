import fs from "node:fs";
import path from "node:path";
import { mock } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import {
  openOpenClawAgentDatabase,
  openOpenClawAgentSqliteWorkerStore,
  withOpenClawAgentDatabaseWrite,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
import { memoryPublicationFaultEntrypoint } from "./manager-publication-fault-entrypoint.test-support.js";
import type { PublicationFaultInput } from "./manager-publication-fault.test-support.js";
import type { MemoryPublicationOperations } from "./manager-publication-task.js";
import { readMemoryShadowIdentity } from "./manager-shadow-task.js";

it.each([
  { failRollback: false, failClose: false, throwResultFailure: false },
  { failRollback: true, failClose: false, throwResultFailure: false },
  { failRollback: true, failClose: true, throwResultFailure: false },
  { failRollback: true, failClose: true, throwResultFailure: true },
])("settles native publication before a sibling write (%j)", async (faults) => {
  const state = await createOpenClawTestState({
    prefix: "memory-publication-settlement-",
    layout: "state-only",
  });
  const events: string[] = [];
  const messages = mock.method(Worker.prototype, "postMessage");
  let worker:
    | Awaited<ReturnType<typeof openOpenClawAgentSqliteWorkerStore<MemoryPublicationOperations>>>
    | undefined;
  let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 10);
  try {
    const options = { agentId: "main", path: path.join(state.stateDir, "agent.sqlite") };
    const { db } = openOpenClawAgentDatabase(options);
    ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
    db.exec(`
      CREATE TABLE sibling (value TEXT);
      INSERT INTO memory_index_sources(path, source, hash, mtime, size)
        VALUES ('memory/current.md', 'memory', 'old', 1, 1);
      CREATE TRIGGER fail_publication BEFORE DELETE ON memory_index_sources
        BEGIN SELECT RAISE(FAIL, 'injected publication failure'); END;
      PRAGMA busy_timeout = 75;
    `);
    const marker = path.join(state.stateDir, "entered");
    const input: PublicationFaultInput = {
      ...faults,
      marker,
      fileIdentity: readMemoryShadowIdentity(options.path),
      pragmas: {
        busy_timeout: 75,
        synchronous: 1,
        foreign_keys: 1,
        wal_autocheckpoint: 0,
        journal_size_limit: 67108864,
        checkpoint_fullfsync: 0,
      },
    };
    worker = await openOpenClawAgentSqliteWorkerStore<MemoryPublicationOperations>(options, db, {
      moduleUrl: resolveRuntimeWorkerUrl(memoryPublicationFaultEntrypoint),
      input,
    });
    const opening = messages.mock.calls.find((call) => {
      const request: unknown = call.arguments[0];
      return (
        typeof request === "object" &&
        request !== null &&
        "databasePath" in request &&
        request.databasePath === options.path
      );
    });
    const nativeWorker = opening?.this;
    if (!(nativeWorker instanceof Worker)) {
      throw new Error("Expected the native publication Worker");
    }
    nativeWorker.once("exit", () => events.push("exit"));
    messages.mock.restore();
    const command = {
      type: "source.delete",
      input: {
        path: "memory/current.md",
        source: "memory",
        expectedHash: "old",
        state: {
          vector: { enabled: false, available: false },
          fts: { enabled: false, available: false },
        },
      },
    } as const;
    const native = worker
      .run(
        (scope) => scope.execute(command),
        () => undefined,
      )
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    const deadline = performance.now() + 5000;
    while (!fs.existsSync(marker)) {
      if (performance.now() >= deadline) {
        throw new Error("Publication did not enter its native transaction");
      }
      await nextTurn();
    }
    const sibling = withOpenClawAgentDatabaseWrite(
      options,
      () => {
        events.push("sibling");
        db.prepare("INSERT INTO sibling VALUES (?)").run("after");
      },
      db,
    );
    // Observe rejection immediately so the red regression does not leak it.
    const siblingResult = sibling.then(
      () => ({ ok: true }),
      (error: unknown) => ({ error }),
    );
    const outcome = await native;
    expect(await siblingResult).toEqual({ ok: true });
    expect(db.prepare("SELECT * FROM sibling").all()).toEqual([{ value: "after" }]);
    expect(db.prepare("SELECT path, hash FROM memory_index_sources").all()).toEqual([
      { path: "memory/current.md", hash: "old" },
    ]);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(ticks).toBeGreaterThan(2);
    if (faults.failRollback) {
      expect(outcome).toMatchObject({
        error: { message: expect.stringContaining("injected publication failure") },
      });
      expect(events).toEqual(["exit", "sibling"]);
      if (faults.throwResultFailure) {
        expect(outcome).toMatchObject({
          error: { message: expect.stringContaining("injected result delivery failure") },
        });
      }
      // A retired slot reports its failure once during close. The owner retains
      // cleanup custody for the explicit retry, which then releases the lease.
      await expect(worker.close()).rejects.toThrow("injected publication failure");
      await expect(worker.close()).resolves.toBeUndefined();
      worker = undefined;
    } else {
      expect(outcome).toMatchObject({ value: { ok: false, entered: true, committed: false } });
      expect(events).toEqual(["sibling"]);
      db.exec("DROP TRIGGER fail_publication");
      await expect(
        worker.run(
          (scope) => scope.execute(command),
          () => undefined,
        ),
      ).resolves.toEqual({ ok: true, value: true });
    }
  } finally {
    clearInterval(heartbeat);
    messages.mock.restore();
    try {
      await worker?.close();
    } finally {
      await state.cleanup();
    }
  }
});

it.each([false, true])(
  "preserves the staged publication outcome when discard fails (publication fails: %s)",
  async (failPublication) => {
    const state = await createOpenClawTestState({
      prefix: "memory-publication-discard-",
      layout: "state-only",
    });
    let worker:
      | Awaited<ReturnType<typeof openOpenClawAgentSqliteWorkerStore<MemoryPublicationOperations>>>
      | undefined;
    try {
      const options = { agentId: "main", path: path.join(state.stateDir, "agent.sqlite") };
      const { db } = openOpenClawAgentDatabase(options);
      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
      db.exec(`
        INSERT INTO memory_index_sources(path, source, hash, mtime, size)
          VALUES ('memory/current.md', 'memory', 'old', 1, 1);
        CREATE TABLE publications (hash TEXT);
        CREATE TRIGGER record_publication AFTER UPDATE ON memory_index_sources
          BEGIN INSERT INTO publications VALUES (NEW.hash); END;
      `);
      if (failPublication) {
        db.exec(`CREATE TRIGGER fail_publication BEFORE UPDATE ON memory_index_sources
          BEGIN SELECT RAISE(FAIL, 'injected publication failure'); END`);
      }
      const input: PublicationFaultInput = {
        marker: path.join(state.stateDir, "entered"),
        failRollback: false,
        failClose: false,
        throwResultFailure: false,
        failDiscard: true,
        fileIdentity: readMemoryShadowIdentity(options.path),
        pragmas: {
          busy_timeout: 75,
          synchronous: 1,
          foreign_keys: 1,
          wal_autocheckpoint: 0,
          journal_size_limit: 67108864,
          checkpoint_fullfsync: 0,
        },
      };
      const open = (failDiscard: boolean) =>
        openOpenClawAgentSqliteWorkerStore<MemoryPublicationOperations>(options, db, {
          moduleUrl: resolveRuntimeWorkerUrl(memoryPublicationFaultEntrypoint),
          input: { ...input, failDiscard },
        });
      const replace = (owner: Awaited<ReturnType<typeof open>>, hash: string) =>
        owner.run(
          async (scope) => {
            await scope.execute({
              type: "stage.start",
              input: {
                operation: hash,
                rows: 0,
                header: {
                  source: "memory",
                  entry: { path: "memory/current.md", hash, mtimeMs: 2, size: 0 },
                  model: "none",
                  now: 2,
                  vectorReady: false,
                },
              },
            });
            return scope.execute({
              type: "source.replace",
              input: {
                operation: hash,
                state: {
                  vector: { enabled: false, available: false },
                  fts: { enabled: false, available: false },
                },
              },
            });
          },
          () => undefined,
        );
      worker = await open(true);
      const outcome = await replace(worker, "new");
      expect(outcome).toMatchObject({
        ok: false,
        entered: true,
        committed: !failPublication,
        error: failPublication
          ? { message: "injected publication failure", code: "ERR_SQLITE_ERROR", errcode: 1811 }
          : { message: "injected staging discard failure" },
      });
      expect(db.prepare("SELECT hash FROM memory_index_sources").all()).toEqual([
        { hash: failPublication ? "old" : "new" },
      ]);
      expect(db.prepare("SELECT hash FROM publications").all()).toEqual(
        failPublication ? [] : [{ hash: "new" }],
      );
      await worker.close();
      worker = undefined;
      db.exec("DROP TRIGGER IF EXISTS fail_publication");
      worker = await open(false);
      await expect(replace(worker, "retry")).resolves.toMatchObject({ ok: true });
      expect(db.prepare("SELECT hash FROM memory_index_sources").all()).toEqual([
        { hash: "retry" },
      ]);
      expect(db.prepare("SELECT hash FROM publications").all()).toEqual([
        ...(failPublication ? [] : [{ hash: "new" }]),
        { hash: "retry" },
      ]);
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      try {
        await worker?.close();
      } finally {
        await state.cleanup();
      }
    }
  },
);
