import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqliteWorkerOperationAdmission } from "../../../infra/sqlite-worker-operation-admission.js";
import { onSessionLifecycleEvent } from "../../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type { runOpenClawStateWorkerOperation } from "../../../state/openclaw-state-worker-store.js";
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
} from "./subagent-registry-state.js";
import type { SubagentRegistryWrite } from "./subagent-registry.store.kernel.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const mocks = vi.hoisted(() => ({
  context: vi.fn<() => OpenClawStateWorkerContext>(),
  runWorker: vi.fn<typeof runOpenClawStateWorkerOperation>(),
  save: vi.fn(),
}));
vi.mock("../../../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: mocks.context,
}));
vi.mock("../../../state/openclaw-state-worker-store.js", () => ({
  runOpenClawStateWorkerOperation: mocks.runWorker,
}));
vi.mock("./subagent-registry.store.codec.js", () => ({
  bindSubagentRunRecord: (entry: SubagentRunRecord) => ({
    run_id: entry.runId,
    child_session_key: entry.childSessionKey,
    controller_session_key: entry.controllerSessionKey ?? null,
    requester_session_key: entry.requesterSessionKey,
    created_at: entry.createdAt,
    payload_json: JSON.stringify(entry),
  }),
}));
vi.mock("./subagent-registry.store.sqlite.js", () => ({
  loadSubagentRegistryFromSqlite: () => new Map(),
  loadSubagentSessionListRunsFromSqlite: () => new Map(),
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
  };
}

function context(): OpenClawStateWorkerContext {
  return {
    admission: {
      databasePath: "/synthetic/state.sqlite",
      identity: { key: "synthetic", canonicalPath: "/synthetic/state.sqlite" },
      assertCurrent: vi.fn(),
    },
    environment: { OPENCLAW_STATE_DIR: "/synthetic" },
    coordinatorRuntime: { directory: "/synthetic/coordinator", keepAlive: false },
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
  afterEach(() => {
    clearSubagentRunsReadCacheForTest();
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
          { context: original },
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
        expect(wake).not.toHaveBeenCalled();
        expect(mocks.save).not.toHaveBeenCalled();
        expect(getSubagentRunsSnapshotForRead(new Map()).size).toBe(0);
      } finally {
        stop();
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
