import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqliteWorkerOperationAdmission } from "../../../infra/sqlite-worker-operation-admission.js";
import { onSessionLifecycleEvent } from "../../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import * as databaseCache from "../../../state/openclaw-state-db-cache.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type { runOpenClawStateWorkerOperation } from "../../../state/openclaw-state-worker-store.js";
import {
  assertSubagentRegistryWriteOutcomeKnown,
  captureSubagentRunMutationSnapshot,
  publishSubagentRunPostimages,
  waitForPendingSubagentKillClaim,
} from "./subagent-registry-persistence.js";
import { getSubagentRegistryPublicationRevision } from "./subagent-registry-publication.js";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentMaintenanceRunsSnapshotForRead,
  getSubagentRunsSnapshotForRead,
  getSubagentSessionListRunsSnapshotForRead,
  onSubagentRegistryPersisted,
  persistSubagentRunsToDiskAsyncOrThrow,
  persistSubagentRunsToDiskOrThrow,
  publishSubagentRunsAfterAtomicStore,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-state.js";
import type { SubagentRegistryWrite } from "./subagent-registry.store.kernel.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const mocks = vi.hoisted(() => ({
  context: vi.fn<() => OpenClawStateWorkerContext>(),
  runWorker: vi.fn<typeof runOpenClawStateWorkerOperation>(),
  save: vi.fn(),
}));
vi.mock("../../../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateReadContext: mocks.context,
  captureOpenClawStateWorkerContext: mocks.context,
}));
vi.mock("../../../state/openclaw-state-worker-store.js", () => ({
  runOpenClawStateWorkerOperation: mocks.runWorker,
}));
vi.mock("./subagent-registry.store.sqlite.js", () => ({
  loadSubagentRegistryFromSqlite: () => new Map(),
  loadSubagentMaintenanceRunsFromSqlite: () => new Map(),
  saveSubagentRegistryChangesToSqlite: mocks.save,
  saveSubagentRegistryToSqlite: mocks.save,
}));

function run(): SubagentRunRecord {
  return {
    runId: "queued",
    childSessionKey: "agent:child:subagent:queued",
    requesterSessionKey: "agent:parent:main",
    requesterDisplayKey: "parent",
    requesterAgentId: "parent",
    task: "captured task",
    cleanup: "keep",
    collect: true,
    groupId: "batch",
    swarmRequesterSessionKey: "agent:parent:main",
    createdAt: 1,
    execution: { status: "queued" },
    completion: { required: false },
    delivery: { status: "not_required" },
  };
}

function context(): OpenClawStateWorkerContext {
  return {
    admission: {
      coordinationKey: "synthetic",
      databasePath: "/synthetic/state.sqlite",
      identity: { key: "synthetic", canonicalPath: "/synthetic/state.sqlite" },
      assertCurrent: vi.fn(),
    },
    environment: { OPENCLAW_STATE_DIR: "/synthetic" },
  };
}

describe("queued registry worker publication", () => {
  let original: OpenClawStateWorkerContext;
  let admission: SqliteWorkerOperationAdmission;
  let command: SubagentRegistryWrite;
  let reply: ReturnType<typeof createDeferredCore<{ writeId: string }>>;
  const previous = process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE;

  beforeEach(() => {
    process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE = "1";
    original = context();
    mocks.context.mockReturnValue(original);
    vi.spyOn(databaseCache, "captureOpenClawStateDatabaseReadAdmission").mockImplementation(
      () => mocks.context().admission,
    );
    mocks.save.mockReset();
    clearSubagentRunsReadCacheForTest();
    reply = createDeferredCore();
    mocks.runWorker.mockImplementation(async (_context, operation, options) => {
      options?.assertCurrent?.();
      const factory = options?.createAdmission;
      if (!factory) {
        throw new Error("Expected retained worker admission");
      }
      admission = factory({ settled: Promise.resolve({ kind: "completed" }) }).admission;
      try {
        return await operation({
          execute: vi.fn().mockImplementation((input: { input: SubagentRegistryWrite }) => {
            command = input.input;
            return reply.promise;
          }),
        });
      } finally {
        admission.finish();
      }
    });
  });
  afterEach(async () => {
    await databaseCache.closeOpenClawStateDatabaseAsync();
    restoreSubagentRunsFromDisk({ runs: new Map() });
    clearSubagentRunsReadCacheForTest();
    vi.restoreAllMocks();
    if (previous === undefined) {
      delete process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE;
    } else {
      process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE = previous;
    }
  });

  async function request(stage: "transaction" | "commit"): Promise<boolean> {
    const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    admission.port.postMessage({ stage, facts: command.writeId, decision: decision.buffer }, []);
    await setImmediate();
    admission.service();
    return Atomics.load(decision, 0) === 1;
  }

  it("publishes the acknowledged immutable delta and exact deletion into all read caches", async () => {
    const entry = run();
    const timestamp = "[Mon 2026-09-21 12:00 UTC] ";
    entry.completion = {
      required: false,
      terminalReply: { disposition: "visible", text: `${timestamp}${timestamp}reply` },
    };
    entry.queuedLaunch = {
      request: { completion: entry.completion },
      timeoutMs: 100,
      schedulerGroupKey: "synthetic",
      maxConcurrent: 1,
    };
    const removed = { ...run(), runId: "removed" };
    persistSubagentRunsToDiskOrThrow(new Map([[removed.runId, removed]]));
    const entries = new Map([[entry.runId, entry]]);
    const wake = vi.fn();
    const stop = onSubagentRegistryPersisted(wake);
    try {
      const pending = persistSubagentRunsToDiskAsyncOrThrow(entries, [entry.runId, removed.runId], {
        context: original,
      });
      entry.task = "later mutable task";
      entry.execution.status = "running";
      entries.set(removed.runId, removed);
      expect(command.deleteRunIds).toEqual([removed.runId]);
      expect(
        JSON.parse(expectDefined(command.values[0]?.payload_json, "captured registry row")),
      ).toMatchObject({
        task: "captured task",
        execution: { status: "queued" },
        completion: { terminalReply: { text: "reply" } },
        queuedLaunch: { request: { completion: { terminalReply: { text: "reply" } } } },
      });
      expect(wake).not.toHaveBeenCalled();
      expect(await request("transaction")).toBe(true);
      expect(await request("commit")).toBe(true);
      reply.resolve({ writeId: command.writeId });
      await pending;
      expect(wake).toHaveBeenCalledOnce();
      for (const read of [
        getSubagentRunsSnapshotForRead,
        getSubagentSessionListRunsSnapshotForRead,
        getSubagentMaintenanceRunsSnapshotForRead,
      ]) {
        const observed = read(new Map());
        expect(observed.get(entry.runId)?.execution.status).toBe("queued");
        expect(observed.has(removed.runId)).toBe(false);
      }
      expect(getSubagentRunsSnapshotForRead(new Map()).get(entry.runId)?.task).toBe(
        "captured task",
      );
      expect(getSubagentRunsSnapshotForRead(new Map()).get(entry.runId)?.completion).toMatchObject({
        terminalReply: { text: `${timestamp}reply` },
      });
    } finally {
      stop();
    }
  });

  it("publishes the staged raw record before waking readers after acknowledgement", async () => {
    const entry = run();
    const entries = new Map([[entry.runId, entry]]);
    const originalExecution = entry.execution;
    const terminal: SubagentRunRecord["execution"] = { status: "terminal", endedAt: 2 };
    const observed: string[] = [];
    const revision = getSubagentRegistryPublicationRevision();
    const sessionObservations: Array<{ revision: number; status: string }> = [];
    const stopSession = sessionChanges.subscribe(() => {
      sessionObservations.push({
        revision: getSubagentRegistryPublicationRevision(),
        status: entry.execution.status,
      });
    });
    const stop = onSubagentRegistryPersisted(() => {
      observed.push(entry.execution.status);
      observed.push(
        expectDefined(getSubagentRunsSnapshotForRead(entries).get(entry.runId), "live row")
          .execution.status,
      );
    });
    try {
      entry.execution = terminal;
      const pending = persistSubagentRunsToDiskAsyncOrThrow(entries, [entry.runId], {
        context: original,
        onCommitted: () => {
          entry.execution = terminal;
        },
      });
      entry.execution = originalExecution;
      expect(observed).toEqual([]);
      expect(sessionObservations).toEqual([]);
      expect(await request("transaction")).toBe(true);
      expect(await request("commit")).toBe(true);
      reply.resolve({ writeId: command.writeId });
      await pending;
      expect(observed).toEqual(["terminal", "terminal"]);
      expect(sessionObservations).toEqual([{ revision: revision + 1, status: "terminal" }]);
    } finally {
      stop();
      stopSession();
    }
  });

  it("keeps a publication failure after acknowledgement known committed without undo or replay", async () => {
    const entry = run();
    const failure = new Error("Synthetic publication failure");
    const successor: SubagentRunRecord = {
      ...entry,
      execution: { status: "terminal", endedAt: 2 },
    };
    const entries = new Map([[entry.runId, entry]]);
    const publish = vi.fn(() => {
      entries.set(entry.runId, successor);
      throw failure;
    });
    const pending = persistSubagentRunsToDiskAsyncOrThrow(entries, [entry.runId], {
      context: original,
      onCommitted: publish,
    });
    const rejected = expect(pending).rejects.toMatchObject({
      outcome: "committed",
      cause: failure,
    });
    expect(await request("transaction")).toBe(true);
    expect(await request("commit")).toBe(true);
    reply.resolve({ writeId: command.writeId });
    await rejected;
    expect(entries.get(entry.runId)).toBe(successor);
    expect(publish).toHaveBeenCalledOnce();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each(["before transaction", "before commit"])(
    "refuses writes superseded %s",
    async (stage) => {
      const entry = run();
      const entries = new Map([[entry.runId, entry]]);
      const pending = persistSubagentRunsToDiskAsyncOrThrow(entries, [entry.runId], {
        context: original,
      });
      const rejected = expect(pending).rejects.toMatchObject({ outcome: "not-committed" });
      if (stage === "before commit") {
        expect(await request("transaction")).toBe(true);
      }
      entry.execution = { status: "terminal", endedAt: 2 };
      persistSubagentRunsToDiskOrThrow(entries, [entry.runId]);
      const granted = await request(stage === "before commit" ? "commit" : "transaction");
      reply.reject(admission.failure ?? new Error("Superseded worker settled"));
      await rejected;
      expect(granted).toBe(false);
      expect(getSubagentRunsSnapshotForRead(new Map()).get(entry.runId)?.execution.status).toBe(
        "terminal",
      );
    },
  );

  it.each(["synchronous", "atomic"])(
    "keeps a newer %s publication after an older committed acknowledgement",
    async (writer) => {
      const entry = run();
      const entries = new Map([[entry.runId, entry]]);
      const publish = vi.fn();
      const pending = persistSubagentRunsToDiskAsyncOrThrow(entries, [entry.runId], {
        context: original,
        onCommitted: publish,
      });
      expect(await request("transaction")).toBe(true);
      expect(await request("commit")).toBe(true);
      entry.execution = { status: "terminal", endedAt: 2 };
      if (writer === "atomic") {
        const deferred: Array<() => void> = [];
        publishSubagentRunsAfterAtomicStore(entries, [entry.runId], deferred);
        deferred.forEach((emit) => emit());
      } else {
        persistSubagentRunsToDiskOrThrow(entries, [entry.runId]);
      }
      const event = vi.fn();
      const stop = onSessionLifecycleEvent(event);
      try {
        reply.resolve({ writeId: command.writeId });
        await pending;
        expect(publish).not.toHaveBeenCalled();
        expect(getSubagentRunsSnapshotForRead(new Map()).get(entry.runId)?.execution.status).toBe(
          "terminal",
        );
        persistSubagentRunsToDiskOrThrow(entries, [entry.runId]);
        expect(event).not.toHaveBeenCalled();
      } finally {
        stop();
      }
    },
  );

  it.each([false, true])(
    "publishes nothing on missing acknowledgement (commit granted=%s)",
    async (granted) => {
      const entry = run();
      const wake = vi.fn();
      const stop = onSubagentRegistryPersisted(wake);
      try {
        const pending = persistSubagentRunsToDiskAsyncOrThrow(
          new Map([[entry.runId, entry]]),
          [entry.runId],
          { context: original, pendingKillClaim: entry },
        );
        const claimWait = waitForPendingSubagentKillClaim(entry, original.admission);
        expect(claimWait).toBeDefined();
        const claimSettlement = claimWait?.then(
          () => "settled",
          (error: unknown) => error,
        );
        const rejected = expect(pending).rejects.toMatchObject({
          outcome: granted ? "unknown" : "not-committed",
        });
        if (granted) {
          expect(await request("transaction")).toBe(true);
          expect(await request("commit")).toBe(true);
        }
        reply.reject(new Error("Worker response unavailable"));
        await rejected;
        if (granted) {
          expect(await claimSettlement).toMatchObject({ outcome: "unknown" });
        } else {
          expect(await claimSettlement).toBe("settled");
        }
        expect(wake).not.toHaveBeenCalled();
        expect(mocks.save).not.toHaveBeenCalled();
        expect(getSubagentRunsSnapshotForRead(new Map()).size).toBe(0);
        if (granted) {
          expect(() =>
            assertSubagentRegistryWriteOutcomeKnown([entry.runId], original.admission),
          ).toThrow();
          expect(() =>
            assertSubagentRegistryWriteOutcomeKnown(["unrelated"], original.admission),
          ).not.toThrow();
          const otherSource = context();
          otherSource.admission = {
            ...otherSource.admission,
            databasePath: "/other/state.sqlite",
            identity: { key: "other", canonicalPath: "/other/state.sqlite" },
          };
          expect(() =>
            assertSubagentRegistryWriteOutcomeKnown([entry.runId], otherSource.admission),
          ).not.toThrow();
          await expect(
            persistSubagentRunsToDiskAsyncOrThrow(new Map([[entry.runId, entry]]), [entry.runId], {
              context: original,
            }),
          ).rejects.toMatchObject({ outcome: "unknown" });
          const unrelated = { ...run(), runId: "unrelated" };
          reply = createDeferredCore();
          const independent = persistSubagentRunsToDiskAsyncOrThrow(
            new Map([[unrelated.runId, unrelated]]),
            [unrelated.runId],
            { context: original },
          );
          expect(await request("transaction")).toBe(true);
          expect(await request("commit")).toBe(true);
          reply.resolve({ writeId: command.writeId });
          await independent;
          expect(
            getSubagentRunsSnapshotForRead(new Map()).get(unrelated.runId)?.execution.status,
          ).toBe("queued");
          await databaseCache.closeOpenClawStateDatabaseAsync();
          expect(
            () => assertSubagentRegistryWriteOutcomeKnown([entry.runId], original.admission),
            "close alone cannot replay a stale preimage",
          ).toThrow();
          restoreSubagentRunsFromDisk({ runs: new Map() });
          expect(() =>
            assertSubagentRegistryWriteOutcomeKnown([entry.runId], original.admission),
          ).not.toThrow();
        }
      } finally {
        stop();
      }
    },
  );

  it.each(["publish", "retire", "caller superseded", "callback failure"] as const)(
    "settles staged native postimages with explicit %s publication custody",
    async (mode) => {
      const entry = run();
      const entries = new Map([[entry.runId, entry]]);
      const preimage = captureSubagentRunMutationSnapshot(entry);
      const execution = entry.execution;
      entry.execution = { status: "terminal", endedAt: 2 };
      let current = true;
      const events: string[] = [];
      const failure = new Error("Memory handoff failed after committed install");
      const stop = onSubagentRegistryPersisted(() => events.push("observer"));
      const attempts = mocks.runWorker.mock.calls.length;
      const pending = publishSubagentRunPostimages({
        runs: entries,
        previous: new Map([[entry, preimage]]),
        retire: mode === "retire" ? new Set([entry]) : undefined,
        context: original,
        persist: (stateContext, callbacks, ...ids) =>
          persistSubagentRunsToDiskAsyncOrThrow(entries, ids, {
            context: stateContext,
            ...callbacks,
          }),
        assertCurrent: () => {
          if (!current) {
            throw new Error("Private cleanup generation rearmed");
          }
        },
        onPublished: () => {
          expect(entries.has(entry.runId)).toBe(mode !== "retire");
          events.push("handoff");
          if (mode === "callback failure") {
            throw failure;
          }
        },
      });
      const settled = pending.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      try {
        expect(entries.get(entry.runId)).toBe(entry);
        expect(entry.execution).toBe(execution);
        expect(command.deleteRunIds).toEqual(mode === "retire" ? [entry.runId] : []);
        expect(await request("transaction")).toBe(true);
        expect(await request("commit")).toBe(true);
        current = mode !== "caller superseded";
        reply.resolve({ writeId: command.writeId });
        const result = await settled;
        if (mode === "callback failure") {
          expect(result).toMatchObject({
            error: { outcome: "committed", publication: "published" },
          });
          expect(entry.execution.status).toBe("terminal");
          expect(events).toEqual(["handoff"]);
        } else if (mode === "caller superseded") {
          expect(result).toEqual({ result: { outcome: "committed", publication: "superseded" } });
          expect(entry.execution).toBe(execution);
          expect(events).toEqual([]);
        } else {
          expect(result).toEqual({ result: { outcome: "committed", publication: "published" } });
          expect(events).toEqual(["handoff", "observer"]);
          if (mode === "publish") {
            expect(entry.execution.status).toBe("terminal");
          }
        }
        expect(mocks.runWorker.mock.calls.length).toBe(attempts + 1);
      } finally {
        stop();
      }
    },
  );

  it.each(["refused", "unknown", "replacement before commit", "replacement after commit"] as const)(
    "retains retirement custody when %s",
    async (mode) => {
      const entry = run();
      const entries = new Map([[entry.runId, entry]]);
      const successor = { ...run(), generation: 2, task: "successor task" };
      const published = vi.fn();
      let current = true;
      const attempts = mocks.runWorker.mock.calls.length;
      const pending = publishSubagentRunPostimages({
        runs: entries,
        previous: new Map([[entry, captureSubagentRunMutationSnapshot(entry)]]),
        retire: new Set([entry]),
        context: original,
        persist: (stateContext, callbacks, ...ids) =>
          persistSubagentRunsToDiskAsyncOrThrow(entries, ids, {
            context: stateContext,
            ...callbacks,
          }),
        assertCurrent: () => {
          if (!current) {
            throw new Error("Retirement owner revoked");
          }
        },
        onPublished: published,
      });
      const settled = pending.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      expect(entries.get(entry.runId)).toBe(entry);
      expect(command.deleteRunIds).toEqual([entry.runId]);
      expect(command.values).toEqual([]);
      expect(await request("transaction")).toBe(true);
      if (mode === "refused") {
        current = false;
      } else if (mode === "replacement before commit") {
        entries.set(entry.runId, successor);
      }
      const committed = mode === "unknown" || mode === "replacement after commit";
      expect(await request("commit")).toBe(committed);
      if (mode === "replacement after commit") {
        entries.set(entry.runId, successor);
        persistSubagentRunsToDiskOrThrow(entries, [entry.runId]);
        reply.resolve({ writeId: command.writeId });
      } else {
        reply.reject(admission.failure ?? new Error("Retirement acknowledgement lost"));
      }
      const result = await settled;
      if (mode === "replacement after commit") {
        expect(result).toEqual({ result: { outcome: "committed", publication: "superseded" } });
        expect(getSubagentRunsSnapshotForRead(new Map()).get(entry.runId)?.task).toBe(
          "successor task",
        );
      } else {
        expect(result).toMatchObject({
          error: { outcome: mode === "unknown" ? "unknown" : "not-committed" },
        });
      }
      expect(entries.get(entry.runId)).toBe(mode.startsWith("replacement") ? successor : entry);
      expect(published).not.toHaveBeenCalled();
      expect(mocks.runWorker.mock.calls.length).toBe(attempts + 1);
      const assertKnown = () =>
        assertSubagentRegistryWriteOutcomeKnown([entry.runId], original.admission);
      if (mode === "unknown") {
        expect(assertKnown).toThrow();
      } else {
        expect(assertKnown).not.toThrow();
      }
    },
  );

  it("does not publish a known commit into a successor database", async () => {
    const entry = run();
    const pending = persistSubagentRunsToDiskAsyncOrThrow(
      new Map([[entry.runId, entry]]),
      [entry.runId],
      { context: original },
    );
    const rejected = expect(pending).rejects.toMatchObject({ outcome: "committed" });
    expect(await request("transaction")).toBe(true);
    expect(await request("commit")).toBe(true);
    const successor = context();
    successor.admission = {
      ...successor.admission,
      identity: { ...successor.admission.identity, key: "successor" },
    };
    mocks.context.mockReturnValue(successor);
    reply.resolve({ writeId: command.writeId });
    await rejected;
    expect(getSubagentRunsSnapshotForRead(new Map()).size).toBe(0);
  });
});
