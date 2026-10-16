import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { mock } from "node:test";
import { Worker } from "node:worker_threads";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import {
  openOpenClawAgentDatabase as openDatabase,
  openOpenClawAgentSqliteWorkerStore as openStore,
  withOpenClawAgentDatabaseWrite as withWrite,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
  requireNativeSqliteDatabase,
  closeOpenClawAgentDatabasesAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
import { readMemoryDatabaseRevision } from "./manager-db-kernel.js";
import { memoryPublicationFaultEntrypoint } from "./manager-publication-fault-entrypoint.test-support.js";
import type { PublicationFaultInput } from "./manager-publication-fault.test-support.js";
import type { MemoryPublicationOperations } from "./manager-publication-task.js";
import { readMemoryConnectionPragmas, readMemoryShadowIdentity } from "./manager-shadow-task.js";

type Faults = Partial<PublicationFaultInput>;
type Admission = Parameters<typeof openStore>[2]["onAdmitted"];

function createPublicationDatabase(stateDir: string) {
  const options = { agentId: "main", path: path.join(stateDir, "agent.sqlite") };
  const db = requireNativeSqliteDatabase(openDatabase(options).db);
  ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
  db.exec(`INSERT INTO memory_index_sources(path, source, hash, mtime, size)
    VALUES ('memory/current.md', 'memory', 'old', 1, 1)`);
  const input: PublicationFaultInput = {
    kind: "publication",
    marker: path.join(stateDir, "entered"),
    failRollback: false,
    failClose: false,
    throwResultFailure: false,
    fileIdentity: readMemoryShadowIdentity(options.path),
    pragmas: readMemoryConnectionPragmas(db, "Expected the canonical connection policy"),
  };
  const messages = mock.method(Worker.prototype, "postMessage");
  const events: string[] = [];
  let worker: PublicationWorker | undefined;
  const close = async () => {
    messages.mock.restore();
    await worker?.close();
    worker = undefined;
  };
  return {
    options,
    db,
    input,
    events,
    async open(source = db, faults: Faults = {}, onAdmitted?: Admission) {
      worker = await openStore<MemoryPublicationOperations>(options, source, {
        moduleUrl: resolveRuntimeWorkerUrl(memoryPublicationFaultEntrypoint),
        input: { ...input, ...faults },
        onAdmitted,
      });
      return worker;
    },
    delete(expectedHash = "old") {
      assert(worker);
      return worker.run((scope) => scope.execute(deleteCommand(expectedHash)), noOp);
    },
    async recover() {
      await close();
      await closeOpenClawAgentDatabasesAsync(stateDir);
      return requireNativeSqliteDatabase(openDatabase(options).db);
    },
    observeExit() {
      const opening = messages.mock.calls.find(
        ({ arguments: [request] }) =>
          typeof request === "object" &&
          request !== null &&
          "databasePath" in request &&
          request.databasePath === options.path,
      );
      const nativeWorker = opening?.this;
      assert(nativeWorker instanceof Worker, "Expected the native publication Worker");
      nativeWorker.once("exit", () => events.push("exit"));
      messages.mock.restore();
    },
    close,
  };
}

const deleteCommand = (expectedHash = "old") => ({
  type: "source.delete" as const,
  input: {
    path: "memory/current.md",
    source: "memory" as const,
    expectedHash,
    state: {
      vector: { enabled: false, available: false },
      fts: { enabled: false, available: false },
    },
  },
});
const noOp = () => undefined;

type PublicationWorker = Awaited<ReturnType<typeof openStore<MemoryPublicationOperations>>>;
const capture = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
function expectSource(db: Pick<DatabaseSync, "prepare">) {
  expect(db.prepare("SELECT * FROM sibling").all()).toEqual([{ value: "after" }]);
  const rows = db.prepare("SELECT path, hash FROM memory_index_sources").all();
  expect(rows).toEqual([{ path: "memory/current.md", hash: "old" }]);
}
function expectIntegrity(db: Pick<DatabaseSync, "prepare">) {
  expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
}
const test = it.extend<{ publication: ReturnType<typeof createPublicationDatabase> }>({
  publication: async ({ task: _task }, use) => {
    await withOpenClawTestState(
      { prefix: "memory-publication-", layout: "state-only" },
      async (state) => {
        const fixture = createPublicationDatabase(state.stateDir);
        try {
          await use(fixture);
        } finally {
          await fixture.close();
        }
      },
    );
  },
});

test.for([
  { failRollback: false, failClose: false, throwResultFailure: false },
  { failRollback: true, failClose: false, throwResultFailure: false },
  { failRollback: true, failClose: true, throwResultFailure: false },
  { failRollback: true, failClose: true, throwResultFailure: true },
])(
  "settles admitted native publication before a sibling write (%j)",
  async (faults, { signal, publication }) => {
    const { events, options, db, input } = publication;
    const transactionEntered = Promise.withResolvers<void>();
    let observingTransaction = false;
    db.exec("CREATE TABLE sibling (value TEXT)");
    const worker = await publication.open(db, faults, (request) => {
      if (observingTransaction && request.stage === "transaction") {
        transactionEntered.resolve();
      }
    });
    observingTransaction = true;
    const native = worker.run(async (scope) => {
      db.exec(`CREATE TRIGGER fail_publication BEFORE DELETE ON memory_index_sources
            BEGIN SELECT RAISE(FAIL, 'injected publication failure'); END`);
      try {
        return await scope.execute(deleteCommand());
      } finally {
        db.exec("DROP TRIGGER fail_publication");
      }
    }, noOp);
    const outcomePromise = capture(native);
    await withinTest(
      awaitGateBeforeSettlement(
        transactionEntered.promise,
        native.then((result) => {
          if (!result.ok) {
            throw Object.assign(new Error(result.error.message), result.error);
          }
        }),
        "Publication settled before transaction admission",
      ),
      signal,
    );
    publication.observeExit();
    const sibling = withWrite(
      options,
      () => {
        events.push("sibling");
        db.prepare("INSERT INTO sibling VALUES (?)").run("after");
      },
      db,
    );
    // Observe rejection immediately so the red regression does not leak it.
    const siblingResult = capture(sibling);
    const outcome = await outcomePromise;
    expect(fs.existsSync(input.marker)).toBe(true);
    expect(await siblingResult).toEqual({ value: undefined });
    expectSource(db);
    expectIntegrity(db);
    if (faults.failRollback) {
      for (const failure of [
        "publication",
        ...(faults.throwResultFailure ? ["result delivery"] : []),
      ]) {
        expect(outcome).toMatchObject({
          error: { cause: { message: expect.stringContaining(`injected ${failure} failure`) } },
        });
      }
      expect(events).toEqual(["exit", "sibling"]);
      // A stale hash proves fresh admission without replaying the uncertain delete.
      await expect(publication.delete("not-current")).resolves.toMatchObject({
        ok: true,
        value: false,
      });
      const recovered = await publication.recover();
      expectSource(recovered);
      await publication.open(recovered);
      await expect(publication.delete()).resolves.toMatchObject({ ok: true, value: true });
      expect(recovered.prepare("SELECT * FROM memory_index_sources").all()).toEqual([]);
      expectIntegrity(recovered);
    } else {
      expect(outcome).toMatchObject({ value: { ok: false, entered: true, committed: false } });
      expect(events).toEqual(["sibling"]);
      await expect(publication.delete()).resolves.toMatchObject({ ok: true, value: true });
    }
  },
);

test("preserves a committed publication when binding cleanup fails", async ({ publication }) => {
  const { events, db } = publication;
  const beforeRevision = readMemoryDatabaseRevision(db);
  const worker = await publication.open(db, { failBindingClose: true });
  let completed: MemoryPublicationOperations["source.delete"]["output"] | undefined;
  let replay: (() => Promise<unknown>) | undefined;
  let callbacks = 0;
  const outcome = await capture(
    worker
      .run(async (scope) => {
        callbacks++;
        completed = await scope.execute(deleteCommand());
        replay = () => scope.execute(deleteCommand());
        publication.observeExit();
        return completed;
      }, noOp)
      .finally(() => {
        events.push("settled");
      }),
  );
  expect(completed).toMatchObject({ ok: true, value: true });
  expect([callbacks, readMemoryDatabaseRevision(db)]).toEqual([1, beforeRevision + 1]);
  expect(db.prepare("SELECT * FROM memory_index_sources").all()).toEqual([]);
  expect(outcome).toEqual({ value: completed });
  assert("value" in outcome && replay && Object.is(outcome.value, completed));
  expect(events).toEqual(["exit", "settled"]);
  await expect(replay()).rejects.toThrow("operation is closed");
  const recovered = await publication.recover();
  expect(readMemoryDatabaseRevision(recovered)).toBe(beforeRevision + 1);
  expect(recovered.prepare("SELECT * FROM memory_index_sources").all()).toEqual([]);
  expectIntegrity(recovered);
});
