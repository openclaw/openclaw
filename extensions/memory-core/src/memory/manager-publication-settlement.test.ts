import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
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
import { closeOpenClawAgentDatabasesAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
import { readMemoryDatabaseRevision } from "./manager-db-kernel.js";
import { memoryPublicationFaultEntrypoint } from "./manager-publication-fault-entrypoint.test-support.js";
import type { PublicationFaultInput } from "./manager-publication-fault.test-support.js";
import type {
  MemoryPublicationConnection,
  MemoryPublicationOperations,
} from "./manager-publication-task.js";
import { readMemoryShadowIdentity } from "./manager-shadow-task.js";

function publicationPragmas(db: DatabaseSync): MemoryPublicationConnection["pragmas"] {
  const read = (name: keyof MemoryPublicationConnection["pragmas"]): number => {
    const row = db.prepare("PRAGMA " + name).get();
    const value = row?.[name] ?? row?.timeout;
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new Error("Expected the canonical connection policy");
    }
    return value;
  };
  return {
    busy_timeout: read("busy_timeout"),
    synchronous: read("synchronous"),
    foreign_keys: read("foreign_keys"),
    wal_autocheckpoint: read("wal_autocheckpoint"),
    journal_size_limit: read("journal_size_limit"),
    checkpoint_fullfsync: read("checkpoint_fullfsync"),
  };
}

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
    `);
    const marker = path.join(state.stateDir, "entered");
    const input: PublicationFaultInput = {
      ...faults,
      marker,
      fileIdentity: readMemoryShadowIdentity(options.path),
      pragmas: publicationPragmas(db),
    };
    worker = await openOpenClawAgentSqliteWorkerStore<MemoryPublicationOperations>(options, db, {
      moduleUrl: resolveRuntimeWorkerUrl(memoryPublicationFaultEntrypoint),
      input,
    });
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
        async (scope) => {
          db.exec(`CREATE TRIGGER fail_publication BEFORE DELETE ON memory_index_sources
            BEGIN SELECT RAISE(FAIL, 'injected publication failure'); END`);
          try {
            return await scope.execute(command);
          } finally {
            db.exec("DROP TRIGGER fail_publication");
          }
        },
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
        error: {
          cause: { message: expect.stringContaining("injected publication failure") },
        },
      });
      expect(events).toEqual(["exit", "sibling"]);
      if (faults.throwResultFailure) {
        expect(outcome).toMatchObject({
          error: {
            cause: { message: expect.stringContaining("injected result delivery failure") },
          },
        });
      }
      // The client can borrow a fresh executor after native retirement; a stale
      // hash proves admission without replaying the uncertain delete.
      await expect(
        worker.run(
          (scope) =>
            scope.execute({
              ...command,
              input: { ...command.input, expectedHash: "not-current" },
            }),
          () => undefined,
        ),
      ).resolves.toEqual({ ok: true, value: false });
      await worker.close();
      worker = undefined;
      await closeOpenClawAgentDatabasesAsync(state.stateDir);
      const recovered = openOpenClawAgentDatabase(options);
      expect(recovered.db.prepare("SELECT * FROM sibling").all()).toEqual([{ value: "after" }]);
      expect(recovered.db.prepare("SELECT path, hash FROM memory_index_sources").all()).toEqual([
        { path: "memory/current.md", hash: "old" },
      ]);
      worker = await openOpenClawAgentSqliteWorkerStore<MemoryPublicationOperations>(
        options,
        recovered.db,
        {
          moduleUrl: resolveRuntimeWorkerUrl(memoryPublicationFaultEntrypoint),
          input: {
            ...input,
            failRollback: false,
            failClose: false,
            throwResultFailure: false,
          },
        },
      );
      await expect(
        worker.run(
          (scope) => scope.execute(command),
          () => undefined,
        ),
      ).resolves.toEqual({ ok: true, value: true });
      expect(recovered.db.prepare("SELECT * FROM memory_index_sources").all()).toEqual([]);
      expect(recovered.db.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
    } else {
      expect(outcome).toMatchObject({ value: { ok: false, entered: true, committed: false } });
      expect(events).toEqual(["sibling"]);
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

it("preserves a committed publication when binding cleanup fails", async () => {
  const state = await createOpenClawTestState({
    prefix: "memory-publication-binding-cleanup-",
    layout: "state-only",
  });
  const messages = mock.method(Worker.prototype, "postMessage");
  const events: string[] = [];
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
    `);
    const beforeRevision = readMemoryDatabaseRevision(db);
    const input: PublicationFaultInput = {
      marker: path.join(state.stateDir, "entered"),
      failRollback: false,
      failClose: false,
      throwResultFailure: false,
      failBindingClose: true,
      fileIdentity: readMemoryShadowIdentity(options.path),
      pragmas: publicationPragmas(db),
    };
    worker = await openOpenClawAgentSqliteWorkerStore<MemoryPublicationOperations>(options, db, {
      moduleUrl: resolveRuntimeWorkerUrl(memoryPublicationFaultEntrypoint),
      input,
    });
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
    let completed: MemoryPublicationOperations["source.delete"]["output"] | undefined;
    let replay: (() => Promise<unknown>) | undefined;
    let callbacks = 0;
    const outcome = await worker
      .run(
        async (scope) => {
          callbacks++;
          completed = await scope.execute(command);
          replay = () => scope.execute(command);
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
          return completed;
        },
        () => undefined,
      )
      .then(
        (value) => {
          events.push("settled");
          return { value };
        },
        (error: unknown) => {
          events.push("settled");
          return { error };
        },
      );
    if (completed === undefined && "error" in outcome) {
      throw outcome.error;
    }
    expect(completed).toEqual({ ok: true, value: true });
    expect(callbacks).toBe(1);
    expect(readMemoryDatabaseRevision(db)).toBe(beforeRevision + 1);
    expect(db.prepare("SELECT * FROM memory_index_sources").all()).toEqual([]);
    expect(outcome).toEqual({ value: completed });
    if (!("value" in outcome) || !replay) {
      throw new Error("Expected the completed publication and its expired scope");
    }
    expect(outcome.value).toBe(completed);
    expect(events).toEqual(["exit", "settled"]);
    await expect(replay()).rejects.toThrow("operation is closed");
    await worker.close();
    worker = undefined;
    await closeOpenClawAgentDatabasesAsync(state.stateDir);
    const recovered = openOpenClawAgentDatabase(options);
    expect(readMemoryDatabaseRevision(recovered.db)).toBe(beforeRevision + 1);
    expect(recovered.db.prepare("SELECT * FROM memory_index_sources").all()).toEqual([]);
    expect(recovered.db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally {
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
      `);
      const beforeRevision = readMemoryDatabaseRevision(db);
      const input: PublicationFaultInput = {
        marker: path.join(state.stateDir, "entered"),
        failRollback: false,
        failClose: false,
        throwResultFailure: false,
        failDiscard: true,
        fileIdentity: readMemoryShadowIdentity(options.path),
        pragmas: publicationPragmas(db),
      };
      const open = (failDiscard: boolean) =>
        openOpenClawAgentSqliteWorkerStore<MemoryPublicationOperations>(options, db, {
          moduleUrl: resolveRuntimeWorkerUrl(memoryPublicationFaultEntrypoint),
          input: { ...input, failDiscard },
        });
      const replace = (
        owner: Awaited<ReturnType<typeof open>>,
        hash: string,
        refusePublication = false,
      ) =>
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
            if (refusePublication) {
              db.exec(`CREATE TRIGGER fail_publication BEFORE UPDATE ON memory_index_sources
                BEGIN SELECT RAISE(FAIL, 'injected publication failure'); END`);
            }
            try {
              return await scope.execute({
                type: "source.replace",
                input: {
                  operation: hash,
                  state: {
                    vector: { enabled: false, available: false },
                    fts: { enabled: false, available: false },
                  },
                },
              });
            } finally {
              if (refusePublication) {
                db.exec("DROP TRIGGER fail_publication");
              }
            }
          },
          () => undefined,
        );
      worker = await open(true);
      const outcome = await replace(worker, "new", failPublication);
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
      expect(readMemoryDatabaseRevision(db)).toBe(beforeRevision + (failPublication ? 0 : 1));
      await worker.close();
      worker = undefined;
      worker = await open(false);
      await expect(replace(worker, "retry")).resolves.toMatchObject({ ok: true });
      expect(db.prepare("SELECT hash FROM memory_index_sources").all()).toEqual([
        { hash: "retry" },
      ]);
      expect(readMemoryDatabaseRevision(db)).toBe(beforeRevision + (failPublication ? 1 : 2));
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
