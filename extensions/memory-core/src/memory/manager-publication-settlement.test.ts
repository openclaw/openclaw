import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { mock } from "node:test";
import { Worker } from "node:worker_threads";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import {
  openOpenClawAgentDatabase,
  openOpenClawAgentSqliteWorkerStore,
  withOpenClawAgentDatabaseWrite,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
  requireNativeSqliteDatabase,
  closeOpenClawAgentDatabasesAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readMemoryDatabaseRevision } from "./manager-db-kernel.js";
import { memoryPublicationFaultEntrypoint } from "./manager-publication-fault-entrypoint.test-support.js";
import type { PublicationFaultInput } from "./manager-publication-fault.test-support.js";
import type { MemoryPublicationOperations } from "./manager-publication-task.js";
import { readMemoryShadowIdentity, type MemoryShadowConnection } from "./manager-shadow-task.js";

function publicationPragmas(db: DatabaseSync): MemoryShadowConnection["pragmas"] {
  const read = (name: keyof MemoryShadowConnection["pragmas"]): number => {
    const row = db.prepare("PRAGMA " + name).get();
    const value = row?.[name] ?? row?.timeout;
    assert(typeof value === "number" && Number.isSafeInteger(value), "Canonical connection policy");
    return value;
  };
  return {
    busy_timeout: read("busy_timeout"),
    synchronous: read("synchronous"),
    foreign_keys: read("foreign_keys"),
    journal_size_limit: read("journal_size_limit"),
    checkpoint_fullfsync: read("checkpoint_fullfsync"),
  };
}

function createPublicationDatabase(stateDir: string) {
  const options = { agentId: "main", path: path.join(stateDir, "agent.sqlite") };
  const db = requireNativeSqliteDatabase(openOpenClawAgentDatabase(options).db);
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
    pragmas: publicationPragmas(db),
  };
  return { options, db, input };
}

const deleteCurrentSource = {
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

function observePublicationExit(
  calls: readonly { arguments: unknown[]; this: unknown }[],
  databasePath: string,
  events: string[],
) {
  const opening = calls.find((call) => {
    const request: unknown = call.arguments[0];
    return (
      typeof request === "object" &&
      request !== null &&
      "databasePath" in request &&
      request.databasePath === databasePath
    );
  });
  const nativeWorker = opening?.this;
  assert(nativeWorker instanceof Worker, "Expected the native publication Worker");
  nativeWorker.once("exit", () => events.push("exit"));
}

type PublicationWorker = Awaited<
  ReturnType<typeof openOpenClawAgentSqliteWorkerStore<MemoryPublicationOperations>>
>;
const runDelete = (worker: PublicationWorker, expectedHash = "old") =>
  worker.run(
    (scope) =>
      scope.execute({
        ...deleteCurrentSource,
        input: { ...deleteCurrentSource.input, expectedHash },
      }),
    () => undefined,
  );
const capture = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
function expectSource(db: Pick<DatabaseSync, "prepare">) {
  expect(db.prepare("SELECT path, hash FROM memory_index_sources").all()).toEqual([
    { path: "memory/current.md", hash: "old" },
  ]);
}
function expectIntegrity(db: Pick<DatabaseSync, "prepare">) {
  expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
}
let currentFixture: Awaited<ReturnType<typeof setupPublication>> | undefined;
beforeEach(async () => {
  currentFixture = undefined;
  currentFixture = await setupPublication();
});
afterEach(async () => {
  const fixture = currentFixture;
  if (!fixture) {
    return;
  }
  fixture.messages.mock.restore();
  try {
    await fixture.worker?.close();
  } finally {
    await fixture.state.cleanup();
  }
});
async function setupPublication() {
  const state = await createOpenClawTestState({
    prefix: "memory-publication-",
    layout: "state-only",
  });
  return {
    state,
    events: [] as string[],
    messages: mock.method(Worker.prototype, "postMessage"),
    worker: undefined as PublicationWorker | undefined,
  };
}
const openWorker = (
  options: Parameters<typeof openOpenClawAgentSqliteWorkerStore>[0],
  db: Parameters<typeof openOpenClawAgentSqliteWorkerStore>[1],
  input: PublicationFaultInput,
  onAdmitted?: NonNullable<Parameters<typeof openOpenClawAgentSqliteWorkerStore>[2]>["onAdmitted"],
) =>
  openOpenClawAgentSqliteWorkerStore<MemoryPublicationOperations>(options, db, {
    moduleUrl: resolveRuntimeWorkerUrl(memoryPublicationFaultEntrypoint),
    input,
    onAdmitted,
  });

it.for([
  { failRollback: false, failClose: false, throwResultFailure: false },
  { failRollback: true, failClose: false, throwResultFailure: false },
  { failRollback: true, failClose: true, throwResultFailure: false },
  { failRollback: true, failClose: true, throwResultFailure: true },
])(
  "settles admitted native publication before a sibling write (%j)",
  async (faults, { signal }) => {
    const fixture = currentFixture;
    assert(fixture);
    const { state, events, messages } = fixture;
    const { options, db, input } = createPublicationDatabase(state.stateDir);
    const transactionEntered = Promise.withResolvers<void>();
    let observingTransaction = false;
    Object.assign(input, faults);
    db.exec("CREATE TABLE sibling (value TEXT)");
    let worker = (fixture.worker = await openWorker(options, db, input, (request) => {
      if (observingTransaction && request.stage === "transaction") {
        transactionEntered.resolve();
      }
    }));
    observingTransaction = true;
    const native = capture(
      worker.run(
        async (scope) => {
          db.exec(`CREATE TRIGGER fail_publication BEFORE DELETE ON memory_index_sources
            BEGIN SELECT RAISE(FAIL, 'injected publication failure'); END`);
          try {
            return await scope.execute(deleteCurrentSource);
          } finally {
            db.exec("DROP TRIGGER fail_publication");
          }
        },
        () => undefined,
      ),
    );
    await withinTest(
      awaitGateBeforeSettlement(
        transactionEntered.promise,
        native.then((outcome) => {
          if ("error" in outcome) {
            throw outcome.error;
          }
          if (!outcome.value.ok) {
            throw Object.assign(new Error(outcome.value.error.message), outcome.value.error);
          }
        }),
        "Publication settled before transaction admission",
      ),
      signal,
    );
    observePublicationExit(messages.mock.calls, options.path, events);
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
    expect(fs.existsSync(input.marker)).toBe(true);
    expect(await siblingResult).toEqual({ ok: true });
    expect(db.prepare("SELECT * FROM sibling").all()).toEqual([{ value: "after" }]);
    expectSource(db);
    expectIntegrity(db);
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
      // A stale hash proves fresh admission without replaying the uncertain delete.
      await expect(runDelete(worker, "not-current")).resolves.toMatchObject({
        ok: true,
        value: false,
      });
      await worker.close();
      fixture.worker = undefined;
      await closeOpenClawAgentDatabasesAsync(state.stateDir);
      const recovered = openOpenClawAgentDatabase(options);
      expect(recovered.db.prepare("SELECT * FROM sibling").all()).toEqual([{ value: "after" }]);
      expectSource(recovered.db);
      worker = fixture.worker = await openWorker(options, recovered.db, {
        ...input,
        failRollback: false,
        failClose: false,
        throwResultFailure: false,
      });
      await expect(runDelete(worker)).resolves.toMatchObject({ ok: true, value: true });
      expect(recovered.db.prepare("SELECT * FROM memory_index_sources").all()).toEqual([]);
      expectIntegrity(recovered.db);
    } else {
      expect(outcome).toMatchObject({ value: { ok: false, entered: true, committed: false } });
      expect(events).toEqual(["sibling"]);
      await expect(runDelete(worker)).resolves.toMatchObject({ ok: true, value: true });
    }
  },
);

it("preserves a committed publication when binding cleanup fails", async () => {
  const fixture = currentFixture;
  assert(fixture);
  const { state, messages, events } = fixture;
  const { options, db, input } = createPublicationDatabase(state.stateDir);
  input.failBindingClose = true;
  const beforeRevision = readMemoryDatabaseRevision(db);
  const worker = (fixture.worker = await openWorker(options, db, input));
  let completed: MemoryPublicationOperations["source.delete"]["output"] | undefined;
  let replay: (() => Promise<unknown>) | undefined;
  let callbacks = 0;
  const outcome = await capture(
    worker
      .run(
        async (scope) => {
          callbacks++;
          completed = await scope.execute(deleteCurrentSource);
          replay = () => scope.execute(deleteCurrentSource);
          observePublicationExit(messages.mock.calls, options.path, events);
          messages.mock.restore();
          return completed;
        },
        () => undefined,
      )
      .finally(() => {
        events.push("settled");
      }),
  );
  if (completed === undefined && "error" in outcome) {
    throw outcome.error;
  }
  expect(completed).toMatchObject({ ok: true, value: true });
  expect(callbacks).toBe(1);
  expect(readMemoryDatabaseRevision(db)).toBe(beforeRevision + 1);
  expect(db.prepare("SELECT * FROM memory_index_sources").all()).toEqual([]);
  expect(outcome).toEqual({ value: completed });
  assert("value" in outcome && replay, "Expected completed publication and expired scope");
  expect(outcome.value).toBe(completed);
  expect(events).toEqual(["exit", "settled"]);
  await expect(replay()).rejects.toThrow("operation is closed");
  await worker.close();
  fixture.worker = undefined;
  await closeOpenClawAgentDatabasesAsync(state.stateDir);
  const recovered = openOpenClawAgentDatabase(options);
  expect(readMemoryDatabaseRevision(requireNativeSqliteDatabase(recovered.db))).toBe(
    beforeRevision + 1,
  );
  expect(recovered.db.prepare("SELECT * FROM memory_index_sources").all()).toEqual([]);
  expectIntegrity(recovered.db);
});
